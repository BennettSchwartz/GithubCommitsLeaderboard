import assert from "node:assert/strict";
import test from "node:test";

import {
  REFRESH_WRITER_GENERATION,
  selectDatabaseConnection,
  switchRefreshWriterGenerationInTransaction,
  withDb,
  withRefreshDb,
  withTransaction,
} from "../src/lib/postgres.ts";

function fakeClient({ database = "canary_db", schema = "canary_schema" } = {}) {
  const trace = [];
  const client = {
    trace,
    async connect() {
      trace.push("CONNECT");
    },
    async end() {
      trace.push("END");
    },
    async query(text, values) {
      const sql = typeof text === "string" ? text : text.text;
      trace.push(sql.replace(/\s+/g, " ").trim());
      if (/current_database\(\)/i.test(sql)) {
        return { rows: [{ database_name: database, schema_name: schema }], rowCount: 1 };
      }
      if (/key = 'refresh_writer_generation'/i.test(sql) && /FOR SHARE/i.test(sql)) {
        return { rows: [{ value: REFRESH_WRITER_GENERATION }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0, values };
    },
  };
  return client;
}

test("selectDatabaseConnection separates cached reads from fresh mutations", () => {
  const env = {
    HYPERDRIVE: { connectionString: "cached" },
    REFRESH_HYPERDRIVE: { connectionString: "fresh" },
    DATABASE_URL: "local",
  };
  assert.deepEqual(selectDatabaseConnection(env, "read"), {
    connectionString: "cached",
    source: "hyperdrive",
  });
  assert.deepEqual(selectDatabaseConnection(env, "refresh"), {
    connectionString: "fresh",
    source: "refresh_hyperdrive",
  });
  assert.deepEqual(selectDatabaseConnection({ DATABASE_URL: "local" }, "refresh"), {
    connectionString: "local",
    source: "local",
  });
  assert.throws(
    () => selectDatabaseConnection({ HYPERDRIVE: { connectionString: "cached" } }, "refresh"),
    /REFRESH_HYPERDRIVE is required for database mutations/,
  );
});

test("withDb and withRefreshDb use their selected connection and close the client", async () => {
  const read = fakeClient();
  const refresh = fakeClient();
  const seen = [];
  await withDb(async () => seen.push("read"), {
    env: { HYPERDRIVE: { connectionString: "cached" } },
    clientFactory(connectionString) {
      assert.equal(connectionString, "cached");
      return read;
    },
  });
  await withRefreshDb(async () => seen.push("refresh"), {
    env: { REFRESH_HYPERDRIVE: { connectionString: "fresh" } },
    clientFactory(connectionString) {
      assert.equal(connectionString, "fresh");
      return refresh;
    },
  });
  assert.deepEqual(seen, ["read", "refresh"]);
  assert.deepEqual(read.trace, ["CONNECT", "END"]);
  assert.deepEqual(refresh.trace, ["CONNECT", "END"]);
});

test("canary identity is complete and checked before the callback", async () => {
  const partial = fakeClient();
  let called = false;
  await assert.rejects(
    withRefreshDb(async () => {
      called = true;
    }, {
      env: {
        DATABASE_URL: "postgres://local/test",
        REFRESH_EXPECTED_DATABASE: "canary_db",
      },
      clientFactory: () => partial,
    }),
    /both REFRESH_EXPECTED_DATABASE and REFRESH_EXPECTED_SCHEMA/,
  );
  assert.equal(called, false);
  assert.equal(partial.trace.includes("CONNECT"), false);

  const mismatch = fakeClient({ schema: "wrong" });
  await assert.rejects(
    withRefreshDb(async () => {
      called = true;
    }, {
      env: {
        DATABASE_URL: "postgres://local/test",
        REFRESH_EXPECTED_DATABASE: "canary_db",
        REFRESH_EXPECTED_SCHEMA: "canary_schema",
      },
      clientFactory: () => mismatch,
    }),
    /database identity mismatch/,
  );
  assert.equal(called, false);

  const matching = fakeClient();
  await withRefreshDb(async () => {
    called = true;
  }, {
    env: {
      DATABASE_URL: "postgres://local/test",
      REFRESH_EXPECTED_DATABASE: "canary_db",
      REFRESH_EXPECTED_SCHEMA: "canary_schema",
    },
    clientFactory: () => matching,
  });
  assert.equal(called, true);
});

test("withTransaction pins the writer marker and commits immediately after callback", async () => {
  const client = fakeClient();
  await withTransaction(client, async (transaction) => {
    await transaction.query("UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE");
    return 7;
  });
  assert.deepEqual(client.trace, [
    "BEGIN",
    "SET LOCAL lock_timeout = '30s'",
    "SET LOCAL statement_timeout = '60s'",
    "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    "SELECT set_config('gcl.refresh_writer_generation', 'queue_v1', TRUE)",
    "SELECT value FROM app_meta WHERE key = 'refresh_writer_generation' FOR SHARE",
    "UPDATE scores SET refresh_attempted_at = NULL WHERE FALSE",
    "COMMIT",
  ]);
});

test("withTransaction rolls back and rethrows the original error", async () => {
  const client = fakeClient();
  const original = new Error("boom");
  await assert.rejects(
    withTransaction(client, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(client.trace.at(-1), "ROLLBACK");
  assert.equal(client.trace.includes("COMMIT"), false);
});

test("non-owning writer switch rejects invalid transitions before SQL", async () => {
  const client = fakeClient();
  await assert.rejects(
    switchRefreshWriterGenerationInTransaction(client, "legacy", "legacy"),
    /different writer generations/,
  );
  assert.deepEqual(client.trace, []);
});
