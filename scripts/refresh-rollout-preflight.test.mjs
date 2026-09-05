import assert from "node:assert/strict";
import test from "node:test";
import { runPreflight } from "./refresh-rollout-preflight.mjs";

const accountId = "776e99cad6263022ce616ccd9c25663e";
const cachedHyperdrive = "aee89c7b5b11441c9ea84decaaab2a08";
const freshHyperdrive = "a-distinct-cache-disabled-hyperdrive";
const workerPath = "/workers/scripts/githubcommitsleaderboard";
const env = { CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "test-token-never-printed",
  DATABASE_URL: "postgres://test:password@db.example.test/leaderboard" };

function fixture({ database = {}, denied = [], settings = {}, queues } = {}) {
  const requests = [];
  const responses = {
    [`${workerPath}/settings`]: {
      compatibility_date: "2026-09-01", usage_model: "standard",
      bindings: [
        { name: "HYPERDRIVE", type: "hyperdrive", id: cachedHyperdrive },
        { name: "REFRESH_HYPERDRIVE", type: "hyperdrive", id: freshHyperdrive },
      ], ...settings,
    },
    [`${workerPath}/deployments`]: { deployments: [{ id: "deployment", versions: [{ version_id: "version", percentage: 100 }] }] },
    [`${workerPath}/schedules`]: { schedules: [{ cron: "*/5 * * * *" }] },
    [`/hyperdrive/configs/${cachedHyperdrive}`]: {
      id: cachedHyperdrive, caching: { disabled: false },
      origin: { host: "db.example.test", port: 5432, database: "leaderboard" },
    },
    "/queues?page=1&per_page=100": queues ?? [
      { queue_name: "githubcommits-refresh", queue_id: "refresh-id" },
      { queue_name: "githubcommits-refresh-dlq", queue_id: "dlq-id" },
    ],
  };
  return { requests, dependencies: {
    readDatabase: async () => ({
      database: "leaderboard", baseTablesPresent: true,
      migrations: ["0003_refresh_scheduler.sql", "0004_refresh_capacity.sql"],
      writerGeneration: "queue_v1", capacity: null, ...database,
    }),
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
      const prefix = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
      assert.ok(url.startsWith(prefix));
      const path = url.slice(prefix.length);
      requests.push(path);
      // Billing is deliberately unavailable: resource access is sufficient.
      if (denied.includes(path) || !(path in responses)) {
        return Response.json({ success: false, errors: [{ message: "access denied" }] }, { status: 403 });
      }
      return Response.json({ success: true, result: responses[path] });
    },
  } };
}

test("resource access passes without billing or account-settings permissions", async () => {
  const { requests, dependencies } = fixture();
  const report = await runPreflight(env, dependencies);
  assert.equal(report.ok, true);
  assert.equal(report.credentialSource, "api_token");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.pendingActions, []);
  assert.equal(requests.length, 5);
  assert.equal(requests.some((path) => /subscriptions|account-settings/.test(path)), false);
  assert.equal(JSON.stringify(report).includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.equal(JSON.stringify(report).includes("password"), false);
});

test("checks explicit account identity before any resource or database access", async () => {
  const { requests, dependencies } = fixture();
  dependencies.readDatabase = () => { throw new Error("must not read the database"); };
  const report = await runPreflight({ ...env, CLOUDFLARE_ACCOUNT_ID: "wrong-account" }, dependencies);
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers.map(({ code }) => code), ["account_identity"]);
  assert.deepEqual(requests, []);
});

test("actual Worker and resource access failures remain blockers", async () => {
  for (const path of [`${workerPath}/settings`, `/hyperdrive/configs/${cachedHyperdrive}`, "/queues?page=1&per_page=100"]) {
    const { dependencies } = fixture({ denied: [path] });
    const report = await runPreflight(env, dependencies);
    assert.equal(report.ok, false);
    assert.deepEqual(report.blockers.map(({ code }) => code), ["cloudflare_read"]);
    assert.ok(report.blockers[0].message.includes(path));
  }
});

test("database identity mismatch and shared mutation binding remain blockers", async () => {
  const wrongDatabase = fixture();
  const originReport = await runPreflight({ ...env, DATABASE_URL: "postgres://test:password@wrong.example.test/leaderboard" }, wrongDatabase.dependencies);
  assert.equal(originReport.ok, false);
  assert.deepEqual(originReport.blockers.map(({ code }) => code), ["database_origin"]);

  const sharedBinding = fixture({ settings: { bindings: [
    { name: "HYPERDRIVE", type: "hyperdrive", id: cachedHyperdrive },
    { name: "REFRESH_HYPERDRIVE", type: "hyperdrive", id: cachedHyperdrive },
  ] } });
  const bindingReport = await runPreflight(env, sharedBinding.dependencies);
  assert.equal(bindingReport.ok, false);
  assert.deepEqual(bindingReport.blockers.map(({ code }) => code), ["refresh_binding"]);
});

test("pending migration and provisioning steps are actionable without blocking access checks", async () => {
  const { dependencies } = fixture({ database: { migrations: [], writerGeneration: "legacy" }, queues: [] });
  const report = await runPreflight(env, dependencies);
  assert.equal(report.ok, true);
  assert.ok(report.pendingActions.some((action) => action.includes("migrations")));
  assert.ok(report.pendingActions.some((action) => action.includes("legacy writer")));
  assert.equal(report.pendingActions.filter((action) => action.startsWith("Create ")).length, 2);
  assert.equal(report.pendingActions.some((action) => /capacity|renewal|billing/i.test(action)), false);
});

test("expired legacy capacity metadata does not gate the bounded producer", async () => {
  const { dependencies } = fixture({ database: { capacity: {
    valid: false, valid_until: "2026-01-01T00:00:00Z", forecast_sha256: "a".repeat(64),
  } } });
  const report = await runPreflight(env, dependencies);
  assert.equal(report.ok, true);
  assert.deepEqual(report.pendingActions, []);
});
