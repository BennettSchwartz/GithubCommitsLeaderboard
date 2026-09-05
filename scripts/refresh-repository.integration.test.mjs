import assert from "node:assert/strict";
import test from "node:test";

import { openIsolatedPostgres } from "./test-support/isolated-postgres.mjs";
import { createRefreshRepository } from "../src/lib/refresh-repository.ts";

async function seedConnected(client, userId, githubId) {
  await client.query(
    `INSERT INTO users (id, github_id, login, login_lc, avatar_url, profile_url, github_created_at)
     VALUES ($1, $2, $3, $3, 'https://example.test/a', 'https://example.test/u', '2020-01-01Z')`,
    [userId, githubId, `user-${githubId}`],
  );
  await client.query(
    "INSERT INTO tokens (user_id, access_token_encrypted) VALUES ($1, 'ciphertext')",
    [userId],
  );
  await client.query(
    "INSERT INTO scores (user_id, next_refresh_at) VALUES ($1, '2020-01-01Z')",
    [userId],
  );
}

test("claims due rows without a forecast lease and commits one compare-and-swap winner", async () => {
  const target = new Date().toISOString();
  const isolated = await openIsolatedPostgres({ required: true });
  const client = await isolated.connect();
  try {
    const userId = "00000000-0000-4000-8000-000000000001";
    await seedConnected(client, userId, 1);
    const repository = createRefreshRepository({ DATABASE_URL: isolated.connectionString });
    const page = await repository.claimDueUsers(target, target, 1);
    assert.equal(page.claims.length, 1);
    assert.equal(page.targetAt, page.enqueuedAt);
    const first = await repository.beginAttempt(page.claims[0].message, target);
    const second = await repository.beginAttempt(page.claims[0].message, target);
    assert.ok(first);
    assert.ok(second);
    assert.equal(await repository.completeSuccess(first, 9), "committed");
    assert.equal(await repository.completeSuccess(second, 10), "stale");

    const state = await client.query(
      `SELECT s.all_time_commits, s.refresh_claim_id,
              (SELECT count(*)::integer FROM score_history WHERE audit_user_id = $1) AS history_count
       FROM scores s WHERE s.user_id = $1`,
      [userId],
    );
    assert.deepEqual(state.rows[0], {
      all_time_commits: 9,
      refresh_claim_id: null,
      history_count: 1,
    });
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});

test("expired forecast metadata does not stop refreshes and token rotation makes an old failure snapshot stale", async () => {
  const isolated = await openIsolatedPostgres({ required: true });
  const client = await isolated.connect();
  try {
    const userId = "00000000-0000-4000-8000-000000000021";
    const target = new Date().toISOString();
    await seedConnected(client, userId, 21);
    const repository = createRefreshRepository({ DATABASE_URL: isolated.connectionString });
    await client.query(`UPDATE refresh_capacity_control
      SET evaluated_at = '2020-01-01T00:00:00Z',
          valid_until = '2020-01-01T06:00:00Z',
          forecast_sha256 = repeat('a', 64)
      WHERE singleton = TRUE`);
    const claim = (await repository.claimDueUsers(target, target, 1)).claims[0];
    const snapshot = await repository.beginAttempt(claim.message, target);
    assert.ok(snapshot);
    assert.equal(await repository.recordRetriableFailure(snapshot, "unknown"), "committed");
    const retryState = await client.query(
      `SELECT refresh_fail_count, refresh_claim_id,
              (SELECT count(*)::integer FROM refresh_attempt_events WHERE user_id = $1) AS events
       FROM scores WHERE user_id = $1`,
      [userId],
    );
    assert.equal(retryState.rows[0].refresh_fail_count, 1);
    assert.equal(retryState.rows[0].refresh_claim_id, claim.claimId);
    assert.equal(retryState.rows[0].events, 1);

    await client.query(
      "UPDATE tokens SET updated_at = updated_at + interval '1 second' WHERE user_id = $1",
      [userId],
    );
    assert.equal(await repository.recordAuthFailure(snapshot), "stale");
    const after = await client.query(
      `SELECT u.needs_reconnect,
              (SELECT count(*)::integer FROM refresh_attempt_events WHERE audit_user_id = $1) AS events
       FROM users u WHERE u.id = $1`,
      [userId],
    );
    assert.equal(after.rows[0].needs_reconnect, false);
    assert.equal(after.rows[0].events, 1);
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});

test("onboarding and DLQ writes preserve committed audit rows after user deletion", async () => {
  const isolated = await openIsolatedPostgres({ required: true });
  const client = await isolated.connect();
  try {
    const userId = "00000000-0000-4000-8000-000000000031";
    const target = new Date().toISOString();
    await seedConnected(client, userId, 31);
    const repository = createRefreshRepository({ DATABASE_URL: isolated.connectionString });
    const begin = await repository.beginOnboardingAttempt(userId);
    assert.equal(begin.kind, "ready");
    assert.equal(await repository.completeOnboardingSuccess(begin.snapshot, 17), "committed");
    await client.query("UPDATE scores SET next_refresh_at = '2020-01-01Z' WHERE user_id = $1", [userId]);
    const claim = (await repository.claimDueUsers(target, target, 1)).claims[0];
    assert.equal(await repository.reconcileDeadLetter("dlq-31", claim.message, target), "committed");
    assert.equal(await repository.reconcileDeadLetter("dlq-31", claim.message, target), "stale");
    const auditBefore = await client.query(
      `SELECT audit_user_id, first_committed_at, last_committed_at
       FROM refresh_dead_letters WHERE queue_message_id = 'dlq-31'`,
    );
    assert.equal(auditBefore.rows[0].audit_user_id, userId);
    const duplicateCounts = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM refresh_dead_letters WHERE queue_message_id = 'dlq-31') AS audits,
         (SELECT count(*)::integer FROM refresh_attempt_events WHERE audit_user_id = $1) AS events`,
      [userId],
    );
    assert.deepEqual(duplicateCounts.rows[0], { audits: 1, events: 1 });

    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    const auditAfter = await client.query(
      `SELECT user_id, audit_user_id, first_committed_at, last_committed_at
       FROM refresh_dead_letters WHERE queue_message_id = 'dlq-31'`,
    );
    assert.equal(auditAfter.rows[0].user_id, null);
    assert.equal(auditAfter.rows[0].audit_user_id, userId);
    assert.equal(
      auditAfter.rows[0].first_committed_at.toISOString(),
      auditBefore.rows[0].first_committed_at.toISOString(),
    );
    assert.equal(
      auditAfter.rows[0].last_committed_at.toISOString(),
      auditBefore.rows[0].last_committed_at.toISOString(),
    );
    const history = await client.query(
      "SELECT user_id, audit_user_id FROM score_history WHERE audit_user_id = $1",
      [userId],
    );
    assert.equal(history.rowCount, 1);
    assert.equal(history.rows[0].user_id, null);
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});
