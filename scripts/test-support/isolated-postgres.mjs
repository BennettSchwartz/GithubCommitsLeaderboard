import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Client } from "pg";

const SCHEMA_PATTERN = /^refresh_test_[a-f0-9]{32}$/;
const WRITER_GENERATIONS = new Set(["legacy", "queue_v1"]);

function parsePostgresUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} must be a PostgreSQL URL`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) {
    throw new Error(`${label} must include a host and database name`);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database,
    parsed,
  };
}

export function assertIsolatedDatabaseUrls(testUrl, productionUrl, label) {
  const test = parsePostgresUrl(testUrl, "TEST_DATABASE_URL");
  if (!productionUrl) return;
  const production = parsePostgresUrl(productionUrl, label);
  if (
    test.host === production.host &&
    test.port === production.port &&
    test.database === production.database
  ) {
    throw new Error(`TEST_DATABASE_URL must not target the same database as ${label}`);
  }
}

function assertSchemaName(schemaName) {
  if (!SCHEMA_PATTERN.test(schemaName)) {
    throw new Error("refusing to operate on an invalid isolated PostgreSQL schema name");
  }
}

function schemaConnectionString(databaseUrl, schemaName) {
  const { parsed } = parsePostgresUrl(databaseUrl, "TEST_DATABASE_URL");
  parsed.searchParams.set("options", `-c search_path=\"${schemaName}\"`);
  return parsed.toString();
}

async function dropSchema(databaseUrl, schemaName) {
  assertSchemaName(schemaName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await client.end();
  }
}

export async function openIsolatedPostgres({
  required = true,
  beforeMigration = {},
  writerGeneration = "queue_v1",
} = {}) {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    if (required) {
      throw new Error("TEST_DATABASE_URL is required for scheduler integration tests");
    }
    return null;
  }
  if (!WRITER_GENERATIONS.has(writerGeneration)) {
    throw new Error("writerGeneration must be legacy or queue_v1");
  }

  assertIsolatedDatabaseUrls(testUrl, process.env.DATABASE_URL, "DATABASE_URL");
  assertIsolatedDatabaseUrls(
    testUrl,
    process.env.GCL_PRODUCTION_DATABASE_URL,
    "GCL_PRODUCTION_DATABASE_URL",
  );

  const schemaName = `refresh_test_${randomUUID().replaceAll("-", "")}`;
  assertSchemaName(schemaName);
  const connectionString = schemaConnectionString(testUrl, schemaName);
  const admin = new Client({ connectionString: testUrl });
  let migrationClient;
  let schemaCreated = false;

  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;

    migrationClient = new Client({ connectionString });
    await migrationClient.connect();
    const schema = await migrationClient.query("SELECT current_schema() AS schema_name");
    if (schema.rows[0]?.schema_name !== schemaName) {
      throw new Error("isolated PostgreSQL connection did not select its generated schema");
    }

    const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const hook = beforeMigration[file];
      if (hook) await hook({ client: migrationClient, schemaName });
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await migrationClient.query("BEGIN");
      try {
        await migrationClient.query("SET LOCAL lock_timeout = '5s'");
        await migrationClient.query("SET LOCAL statement_timeout = '60s'");
        await migrationClient.query(sql);
        await migrationClient.query(
          "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [file],
        );
        await migrationClient.query("COMMIT");
      } catch (error) {
        await migrationClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    if (writerGeneration === "queue_v1") {
      await migrationClient.query("BEGIN");
      try {
        await migrationClient.query(
          "SELECT value FROM app_meta WHERE key = 'refresh_writer_generation' FOR UPDATE",
        );
        await migrationClient.query(
          "UPDATE refresh_capacity_control SET generation = generation + 1, evaluated_at = NULL, valid_until = NULL, forecast_sha256 = NULL WHERE singleton = TRUE",
        );
        const bumped = await migrationClient.query(
          "UPDATE app_meta SET value = ((value)::integer + 1)::text, updated_at = clock_timestamp() WHERE key = 'leaderboard_version'",
        );
        if (bumped.rowCount !== 1) throw new Error("missing leaderboard_version singleton");
        await migrationClient.query(
          "UPDATE app_meta SET value = 'queue_v1', updated_at = clock_timestamp() WHERE key = 'refresh_writer_generation'",
        );
        await migrationClient.query("COMMIT");
      } catch (error) {
        await migrationClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    await migrationClient.end();
    migrationClient = undefined;
    await admin.end();

    const connect = async () => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const selected = await client.query("SELECT current_schema() AS schema_name");
        if (selected.rows[0]?.schema_name !== schemaName) {
          throw new Error("isolated PostgreSQL connection did not select its generated schema");
        }
        if (writerGeneration === "queue_v1") {
          await client.query(
            "SELECT set_config('gcl.refresh_writer_generation', 'queue_v1', FALSE)",
          );
        }
        return client;
      } catch (error) {
        await client.end().catch(() => undefined);
        throw error;
      }
    };

    const cleanup = async () => {
      assertSchemaName(schemaName);
      await dropSchema(testUrl, schemaName);
    };

    return { schemaName, connectionString, connect, cleanup };
  } catch (error) {
    if (migrationClient) await migrationClient.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (schemaCreated) await dropSchema(testUrl, schemaName).catch(() => undefined);
    throw error;
  }
}
