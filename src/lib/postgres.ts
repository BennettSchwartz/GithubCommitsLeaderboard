import { Client } from "pg";

import { getRuntimeEnv, type RuntimeEnv } from "./runtime-env";

export type Queryable = Pick<Client, "query">;

export type DatabaseConnectionSelection = {
  connectionString: string;
  source: "hyperdrive" | "refresh_hyperdrive" | "local";
};

export type PostgresExecutionOptions = {
  env?: Partial<RuntimeEnv>;
  clientFactory?: (connectionString: string) => Client;
};

export const REFRESH_WRITER_GENERATION = "queue_v1" as const;
export const MAX_HISTORY_VISIBILITY_LAG_SECONDS = 125;

type WriterGeneration = "legacy" | "queue_v1";

export function selectDatabaseConnection(
  env: Partial<RuntimeEnv>,
  purpose: "read" | "refresh",
): DatabaseConnectionSelection {
  if (purpose === "read") {
    if (env.HYPERDRIVE?.connectionString) {
      return { connectionString: env.HYPERDRIVE.connectionString, source: "hyperdrive" };
    }
    if (env.DATABASE_URL) {
      return { connectionString: env.DATABASE_URL, source: "local" };
    }
    throw new Error("No database connection string available. Set HYPERDRIVE binding or DATABASE_URL.");
  }

  if (env.REFRESH_HYPERDRIVE?.connectionString) {
    return {
      connectionString: env.REFRESH_HYPERDRIVE.connectionString,
      source: "refresh_hyperdrive",
    };
  }
  if (env.HYPERDRIVE?.connectionString) {
    throw new Error("REFRESH_HYPERDRIVE is required for database mutations");
  }
  if (env.DATABASE_URL) {
    return { connectionString: env.DATABASE_URL, source: "local" };
  }
  throw new Error("No database connection string available for database mutations.");
}

function assertCompleteExpectedIdentity(env: Partial<RuntimeEnv>) {
  const hasDatabase = Boolean(env.REFRESH_EXPECTED_DATABASE);
  const hasSchema = Boolean(env.REFRESH_EXPECTED_SCHEMA);
  if (hasDatabase !== hasSchema) {
    throw new Error(
      "both REFRESH_EXPECTED_DATABASE and REFRESH_EXPECTED_SCHEMA are required for canary identity checks",
    );
  }
}

async function executeWithConnection<T>(
  purpose: "read" | "refresh",
  callback: (client: Client, env: RuntimeEnv) => Promise<T>,
  options: PostgresExecutionOptions = {},
) {
  const env = await getRuntimeEnv(options.env);
  assertCompleteExpectedIdentity(env);
  const selection = selectDatabaseConnection(env, purpose);
  const client = options.clientFactory
    ? options.clientFactory(selection.connectionString)
    : new Client({ connectionString: selection.connectionString });
  await client.connect();
  try {
    if (env.REFRESH_EXPECTED_DATABASE && env.REFRESH_EXPECTED_SCHEMA) {
      const identity = await client.query<{
        database_name: string;
        schema_name: string;
      }>(
        "SELECT current_database() AS database_name, current_schema() AS schema_name",
      );
      const actual = identity.rows[0];
      if (
        actual?.database_name !== env.REFRESH_EXPECTED_DATABASE ||
        actual?.schema_name !== env.REFRESH_EXPECTED_SCHEMA
      ) {
        throw new Error("database identity mismatch for refresh connection");
      }
    }
    return await callback(client, env);
  } finally {
    await client.end();
  }
}

export async function withDb<T>(
  callback: (client: Client, env: RuntimeEnv) => Promise<T>,
  options?: PostgresExecutionOptions,
): Promise<T> {
  return executeWithConnection("read", callback, options);
}

export async function withRefreshDb<T>(
  callback: (client: Client, env: RuntimeEnv) => Promise<T>,
  options?: PostgresExecutionOptions,
): Promise<T> {
  return executeWithConnection("refresh", callback, options);
}

export async function withTransaction<T>(
  client: Client,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    await client.query("SELECT set_config('gcl.refresh_writer_generation', 'queue_v1', TRUE)");
    const writer = await client.query<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'refresh_writer_generation' FOR SHARE",
    );
    if (writer.rowCount !== 1 || writer.rows[0]?.value !== REFRESH_WRITER_GENERATION) {
      throw new Error("refresh writer generation is not queue_v1");
    }
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertWriterTransition(from: WriterGeneration, to: WriterGeneration) {
  if (!(["legacy", "queue_v1"] as string[]).includes(from) ||
      !(["legacy", "queue_v1"] as string[]).includes(to)) {
    throw new Error("unknown refresh writer generation");
  }
  if (from === to) throw new Error("from and to must be different writer generations");
}

export async function switchRefreshWriterGenerationInTransaction(
  client: Client,
  from: WriterGeneration,
  to: WriterGeneration,
): Promise<{ from: WriterGeneration; to: WriterGeneration; switchedAt: string }> {
  assertWriterTransition(from, to);
  await client.query("SAVEPOINT gcl_writer_switch_guard");
  const current = await client.query<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'refresh_writer_generation' FOR UPDATE",
  );
  if (current.rowCount !== 1 || current.rows[0]?.value !== from) {
    throw new Error(`refresh writer generation is not ${from}`);
  }
  const capacity = await client.query(
    "SELECT generation FROM refresh_capacity_control WHERE singleton = TRUE FOR UPDATE",
  );
  if (capacity.rowCount !== 1) throw new Error("missing refresh_capacity_control singleton");
  await client.query(
    "UPDATE refresh_capacity_control SET generation = generation + 1, evaluated_at = NULL, valid_until = NULL, forecast_sha256 = NULL WHERE singleton = TRUE",
  );
  if (from === "legacy" && to === "queue_v1") {
    const bumped = await client.query(
      "UPDATE app_meta SET value = ((value)::integer + 1)::text, updated_at = clock_timestamp() WHERE key = 'leaderboard_version'",
    );
    if (bumped.rowCount !== 1) throw new Error("missing leaderboard_version singleton");
  }
  const switched = await client.query<{ switched_at: Date | string }>(
    "UPDATE app_meta SET value = $1, updated_at = clock_timestamp() WHERE key = 'refresh_writer_generation' RETURNING updated_at AS switched_at",
    [to],
  );
  if (switched.rowCount !== 1 || !switched.rows[0]) {
    throw new Error("failed to switch refresh writer generation");
  }
  await client.query("RELEASE SAVEPOINT gcl_writer_switch_guard");
  const switchedAt = switched.rows[0].switched_at;
  return {
    from,
    to,
    switchedAt: switchedAt instanceof Date ? switchedAt.toISOString() : new Date(switchedAt).toISOString(),
  };
}

export async function switchRefreshWriterGeneration(
  client: Client,
  from: WriterGeneration,
  to: WriterGeneration,
): Promise<{ from: WriterGeneration; to: WriterGeneration; switchedAt: string }> {
  assertWriterTransition(from, to);
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await switchRefreshWriterGenerationInTransaction(client, from, to);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
