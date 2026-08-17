import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Client } from "pg";

import {
  assertIsolatedDatabaseUrls,
  openIsolatedPostgres,
} from "./test-support/isolated-postgres.mjs";
import { switchRefreshWriterGeneration } from "../src/lib/postgres.ts";

const CHECKED_USER = "00000000-0000-4000-8000-000000000011";
const UNCHECKED_USER = "00000000-0000-4000-8000-000000000012";
const CHECKPOINT = "2026-08-01T00:00:00.000Z";

async function seedLegacyRows({ client }) {
  for (const [id, githubId, login] of [
    [CHECKED_USER, 11, "checked"],
    [UNCHECKED_USER, 12, "unchecked"],
  ]) {
    await client.query(
      `INSERT INTO users (
         id, github_id, login, login_lc, avatar_url, profile_url, github_created_at
       ) VALUES ($1, $2, $3, $3, 'https://example.test/a', 'https://example.test/u', '2020-01-01Z')`,
      [id, githubId, login],
    );
    await client.query(
      "INSERT INTO tokens (user_id, access_token_encrypted) VALUES ($1, 'ciphertext')",
      [id],
    );
  }
  await client.query(
    `INSERT INTO scores (user_id, all_time_commits, last_checked_at, last_updated_at)
     VALUES ($1, 7, $2, $2), ($3, 0, NULL, NULL)`,
    [CHECKED_USER, CHECKPOINT, UNCHECKED_USER],
  );
  await client.query(
    "INSERT INTO score_history (user_id, all_time_commits, recorded_at) VALUES ($1, 7, $2)",
    [CHECKED_USER, CHECKPOINT],
  );
}

test("migration backfills scheduler state and generation switch fences both writers", async () => {
  const isolated = await openIsolatedPostgres({
    required: true,
    writerGeneration: "legacy",
    beforeMigration: { "0003_refresh_scheduler.sql": seedLegacyRows },
  });
  const client = await isolated.connect();
  try {
    const state = await client.query(
      `SELECT user_id, next_refresh_at, last_checked_at
       FROM scores ORDER BY user_id`,
    );
    assert.equal(state.rows.length, 2);
    assert.equal(
      state.rows[0].next_refresh_at.toISOString(),
      new Date(new Date(CHECKPOINT).getTime() + 60 * 60 * 60 * 1000).toISOString(),
    );
    assert.ok(state.rows[1].next_refresh_at instanceof Date);

    const history = await client.query(
      "SELECT user_id, audit_user_id, recorded_at, committed_at FROM score_history",
    );
    assert.equal(history.rows[0].audit_user_id, CHECKED_USER);
    assert.equal(history.rows[0].committed_at.toISOString(), history.rows[0].recorded_at.toISOString());

    const schema = await client.query("SELECT current_schema() AS schema_name");
    assert.equal(schema.rows[0].schema_name, isolated.schemaName);
    const index = await client.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition
       FROM pg_index WHERE indexrelid = 'scores_refresh_due_idx'::regclass`,
    );
    assert.match(
      index.rows[0].definition,
      /\(next_refresh_at, user_id\) INCLUDE \(refresh_claimed_until\)/,
    );
    const tables = await client.query(
      `SELECT to_regclass('refresh_dead_letters') AS dead_letters,
              to_regclass('refresh_attempt_events') AS attempt_events,
              to_regclass('refresh_capacity_control') AS capacity_control`,
    );
    assert.ok(tables.rows[0].dead_letters);
    assert.ok(tables.rows[0].attempt_events);
    assert.ok(tables.rows[0].capacity_control);

    await client.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE");
    const before = await client.query(
      "SELECT value::integer AS version FROM app_meta WHERE key = 'leaderboard_version'",
    );
    const switched = await switchRefreshWriterGeneration(client, "legacy", "queue_v1");
    assert.deepEqual({ from: switched.from, to: switched.to }, { from: "legacy", to: "queue_v1" });
    const after = await client.query(
      "SELECT value::integer AS version FROM app_meta WHERE key = 'leaderboard_version'",
    );
    assert.equal(after.rows[0].version, before.rows[0].version + 1);

    await assert.rejects(
      client.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE"),
      (error) => error?.code === "55000",
    );
    await client.query("SELECT set_config('gcl.refresh_writer_generation', 'queue_v1', FALSE)");
    await client.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE");

    const eventKey = "b".repeat(64);
    const claimId = "00000000-0000-4000-8000-000000000099";
    await client.query(
      `INSERT INTO refresh_attempt_events (
         event_key, user_id, audit_user_id, claim_id, attempted_at, category, disposition
       ) VALUES ($1, $2, $2, $3, $4, 'unknown', 'retry')`,
      [eventKey, CHECKED_USER, claimId, CHECKPOINT],
    );
    await client.query(
      `INSERT INTO refresh_dead_letters (
         queue_message_id, user_id, claim_id, attempt_event_key, error_category,
         first_observed_at, last_observed_at
       ) VALUES ('audit-delete', $1, $2, $3, 'unknown', $4, $4)`,
      [CHECKED_USER, claimId, eventKey, CHECKPOINT],
    );
    await assert.rejects(
      client.query("UPDATE score_history SET user_id = NULL WHERE user_id = $1", [CHECKED_USER]),
      (error) => error?.code === "55000",
    );
    await assert.rejects(
      client.query("UPDATE refresh_attempt_events SET user_id = NULL WHERE event_key = $1", [eventKey]),
      (error) => error?.code === "55000",
    );
    await assert.rejects(
      client.query("UPDATE refresh_dead_letters SET user_id = NULL WHERE queue_message_id = 'audit-delete'"),
      (error) => error?.code === "55000",
    );
    const auditBefore = await client.query(
      `SELECT first_committed_at, last_committed_at
       FROM refresh_dead_letters WHERE queue_message_id = 'audit-delete'`,
    );
    await client.query("DELETE FROM users WHERE id = $1", [CHECKED_USER]);
    const auditAfter = await client.query(
      `SELECT user_id, audit_user_id, first_committed_at, last_committed_at
       FROM refresh_dead_letters WHERE queue_message_id = 'audit-delete'`,
    );
    assert.equal(auditAfter.rows[0].user_id, null);
    assert.equal(auditAfter.rows[0].audit_user_id, CHECKED_USER);
    assert.equal(
      auditAfter.rows[0].first_committed_at.toISOString(),
      auditBefore.rows[0].first_committed_at.toISOString(),
    );
    assert.equal(
      auditAfter.rows[0].last_committed_at.toISOString(),
      auditBefore.rows[0].last_committed_at.toISOString(),
    );
    const surviving = await client.query(
      `SELECT
         (SELECT user_id FROM score_history WHERE audit_user_id = $1 LIMIT 1) AS history_user,
         (SELECT user_id FROM refresh_attempt_events WHERE event_key = $2) AS attempt_user`,
      [CHECKED_USER, eventKey],
    );
    assert.equal(surviving.rows[0].history_user, null);
    assert.equal(surviving.rows[0].attempt_user, null);

    await switchRefreshWriterGeneration(client, "queue_v1", "legacy");
    await assert.rejects(
      client.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE"),
      (error) => error?.code === "55000",
    );
    await client.query("SELECT set_config('gcl.refresh_writer_generation', 'legacy', FALSE)");
    await client.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE");
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});

test("a failing migration hook removes the generated schema", async () => {
  let generatedSchema;
  await assert.rejects(
    openIsolatedPostgres({
      required: true,
      beforeMigration: {
        "0003_refresh_scheduler.sql": async ({ schemaName }) => {
          generatedSchema = schemaName;
          throw new Error("fixture failure");
        },
      },
    }),
    /fixture failure/,
  );
  assert.match(generatedSchema, /^refresh_test_[a-f0-9]{32}$/);
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    const namespace = await admin.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [generatedSchema],
    );
    assert.equal(namespace.rowCount, 0);
  } finally {
    await admin.end();
  }
});

test("the real migration runner times out atomically behind a legacy writer then retries", async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  assert.ok(testUrl, "TEST_DATABASE_URL is required for scheduler integration tests");
  assertIsolatedDatabaseUrls(testUrl, process.env.DATABASE_URL, "DATABASE_URL");
  assertIsolatedDatabaseUrls(
    testUrl,
    process.env.GCL_PRODUCTION_DATABASE_URL,
    "GCL_PRODUCTION_DATABASE_URL",
  );
  const schemaName = `refresh_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schemaName, /^refresh_test_[a-f0-9]{32}$/);
  const scoped = new URL(testUrl);
  scoped.searchParams.set("options", `-c search_path=\"${schemaName}\"`);
  const connectionString = scoped.toString();
  const admin = new Client({ connectionString: testUrl });
  const writer = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await writer.connect();
    for (const file of ["0001_init.sql", "0002_score_history.sql"]) {
      const sql = await fs.readFile(path.resolve("db", "migrations", file), "utf8");
      await writer.query("BEGIN");
      await writer.query(sql);
      await writer.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [file],
      );
      await writer.query("COMMIT");
    }
    await writer.query("BEGIN");
    await writer.query("UPDATE users SET updated_at = updated_at WHERE FALSE");

    const startedAt = Date.now();
    const blocked = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(blocked.status, 0, `${blocked.stdout}\n${blocked.stderr}`);
    assert.ok(Date.now() - startedAt < 12_000, "migration lock timeout was not bounded");
    const partial = await writer.query(
      `SELECT
         EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0003_refresh_scheduler.sql') AS recorded,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'scores'
             AND column_name = 'refresh_claim_id'
         ) AS column_exists`,
    );
    assert.deepEqual(partial.rows[0], { recorded: false, column_exists: false });
    await writer.query("ROLLBACK");

    const retried = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    const applied = await writer.query(
      "SELECT 1 FROM schema_migrations WHERE version = '0003_refresh_scheduler.sql'",
    );
    assert.equal(applied.rowCount, 1);
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    await writer.end().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
  }
});
