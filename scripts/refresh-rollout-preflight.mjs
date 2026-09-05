import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const ACCOUNT_ID = "776e99cad6263022ce616ccd9c25663e";
const WORKER = "githubcommitsleaderboard";
const CACHED_HYPERDRIVE = "aee89c7b5b11441c9ea84decaaab2a08";
const OAUTH_CONFIG = "/Users/bennettschwartz/Library/Preferences/.wrangler/config/default.toml";
const QUEUES = ["githubcommits-refresh", "githubcommits-refresh-dlq"];
const HELP = `Read-only production refresh preflight (no resource or database writes).

Usage:
  CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} node \\
    --env-file=/absolute/path/to/.env.local scripts/refresh-rollout-preflight.mjs

Requires DATABASE_URL and the explicit account ID above. Authentication uses
CLOUDFLARE_API_TOKEN, or the existing Wrangler OAuth config. This script does not
refresh credentials. Workers Scripts Read, Hyperdrive Read, and Queues Read
access are needed. Billing and account-settings access are not required.

Outputs sanitized JSON. Exit 1 means a blocker or unverifiable prerequisite.
pendingActions lists ordinary rollout steps, not authorization requests.
These are access and inventory checks only; activation readiness is not assessed.
Fresh Hyperdrive caching and runtime health are not verified here. This script
does not deploy the Worker.
`;

class PreflightError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function databaseIdentity(raw) {
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
    return { host: url.hostname.toLowerCase(), port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)) };
  } catch { throw new PreflightError("database_url", "DATABASE_URL must name a PostgreSQL host and database."); }
}

async function credentials(env) {
  if (env.CLOUDFLARE_API_TOKEN) return { token: env.CLOUDFLARE_API_TOKEN, source: "api_token" };
  let config;
  try { config = await readFile(OAUTH_CONFIG, "utf8"); }
  catch { throw new PreflightError("cloudflare_auth", "Set CLOUDFLARE_API_TOKEN with the required read permissions, or authenticate Wrangler."); }
  const token = /^oauth_token\s*=\s*"([^"\r\n]+)"\s*$/m.exec(config)?.[1];
  const expires = /^expiration_time\s*=\s*"([^"\r\n]+)"\s*$/m.exec(config)?.[1];
  if (!token || !expires || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()) {
    throw new PreflightError("cloudflare_auth", "Wrangler OAuth is missing or expired. Refresh Wrangler credentials or set CLOUDFLARE_API_TOKEN with resource read access.");
  }
  return { token, source: "wrangler_oauth" };
}

function apiReader(token, fetchImpl) {
  return async (path) => {
    let response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
        method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
    } catch { throw new PreflightError("cloudflare_network", `Cloudflare GET ${path} failed; check connectivity and retry.`); }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) {
      throw new PreflightError("cloudflare_read", `Cloudflare GET ${path} returned HTTP ${response.status}. Check token read permissions for this resource and the expected account.`);
    }
    return data;
  };
}

async function inspectDatabase(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows: [tables] } = await client.query(`SELECT current_database() AS database,
      current_schema() AS schema, clock_timestamp() AS observed_at,
      to_regclass('schema_migrations') IS NOT NULL AS has_migrations,
      to_regclass('users') IS NOT NULL AND to_regclass('tokens') IS NOT NULL
        AND to_regclass('scores') IS NOT NULL AND to_regclass('app_meta') IS NOT NULL AS has_base,
      to_regclass('refresh_capacity_control') IS NOT NULL AS has_capacity`);
    const migrations = tables.has_migrations
      ? (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((row) => row.version) : [];
    let writer = null, counts = null, capacity = null;
    if (tables.has_base) {
      writer = (await client.query("SELECT value FROM app_meta WHERE key = 'refresh_writer_generation'")).rows[0]?.value ?? null;
      counts = (await client.query(`SELECT count(*)::integer AS users,
        count(*) FILTER (WHERE u.needs_reconnect)::integer AS reconnect,
        count(*) FILTER (WHERE NOT u.needs_reconnect AND t.user_id IS NOT NULL)::integer AS connected,
        count(*) FILTER (WHERE NOT u.needs_reconnect AND t.user_id IS NOT NULL AND s.last_checked_at IS NULL)::integer AS never_checked,
        count(*) FILTER (WHERE NOT u.needs_reconnect AND t.user_id IS NOT NULL
          AND (s.last_checked_at IS NULL OR s.last_checked_at <= now() - INTERVAL '60 hours'))::integer AS stale_healthy,
        min(s.last_checked_at) FILTER (WHERE NOT u.needs_reconnect AND t.user_id IS NOT NULL) AS oldest_healthy_checkpoint
        FROM users u LEFT JOIN tokens t ON t.user_id = u.id LEFT JOIN scores s ON s.user_id = u.id`)).rows[0];
    }
    if (tables.has_capacity) {
      capacity = (await client.query(`SELECT generation::text, evaluated_at, valid_until,
        forecast_sha256, COALESCE(evaluated_at <= clock_timestamp() AND valid_until > clock_timestamp()
          AND forecast_sha256 ~ '^[a-f0-9]{64}$', FALSE) AS valid
        FROM refresh_capacity_control WHERE singleton = TRUE`)).rows[0] ?? null;
    }
    await client.query("ROLLBACK");
    return { database: tables.database, schema: tables.schema, observedAt: tables.observed_at,
      baseTablesPresent: tables.has_base, migrations, writerGeneration: writer, capacity, counts };
  } catch (error) {
    // pg errors can embed usernames, DSNs, or SQL data; never emit raw errors.
    const code = /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? ` SQLSTATE ${error.code}.` : "";
    throw new PreflightError("database_read", `Read-only PostgreSQL preflight failed.${code} Check DATABASE_URL, connectivity, and schema access.`);
  } finally { await client.end().catch(() => undefined); }
}

export async function runPreflight(env = process.env, {
  readDatabase = inspectDatabase, readCredentials = credentials, fetchImpl = fetch,
} = {}) {
  const report = { observedAt: new Date().toISOString(), accountId: ACCOUNT_ID, worker: WORKER,
    readOnly: true, activationReadiness: "not_assessed", blockers: [], pendingActions: [] };
  const block = (error) => report.blockers.push({ code: error.code ?? "preflight", message: error.message });
  if (env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) {
    block(new PreflightError("account_identity", `Set CLOUDFLARE_ACCOUNT_ID explicitly to ${ACCOUNT_ID}.`));
    return { ...report, ok: false };
  }
  let origin, auth;
  try { origin = databaseIdentity(env.DATABASE_URL); } catch (error) { block(error); }
  try { auth = await readCredentials(env); report.credentialSource = auth.source; } catch (error) { block(error); }
  const api = auth && apiReader(auth.token, fetchImpl);
  const tasks = {
    database: () => origin && readDatabase(env.DATABASE_URL),
    settings: () => api?.(`/workers/scripts/${WORKER}/settings`),
    deployments: () => api?.(`/workers/scripts/${WORKER}/deployments`),
    schedules: () => api?.(`/workers/scripts/${WORKER}/schedules`),
    cachedHyperdrive: () => api?.(`/hyperdrive/configs/${CACHED_HYPERDRIVE}`),
    queues: async () => {
      if (!api) return;
      const found = [];
      for (let page = 1; page <= 100; page += 1) {
        const data = await api(`/queues?page=${page}&per_page=100`);
        if (!Array.isArray(data.result)) throw new PreflightError("queues_shape", "Cloudflare queue inventory response is malformed.");
        found.push(...data.result);
        if (data.result.length < 100 || page >= data.result_info?.total_pages) return { result: found };
      }
      throw new PreflightError("queues_pagination", "Queue inventory exceeded the bounded page limit.");
    },
  };
  const entries = Object.entries(tasks);
  const results = {};
  const settled = await Promise.allSettled(entries.map(([, task]) => task()));
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") results[entries[index][0]] = result.value;
    else block(result.reason);
  });
  const result = (name) => results[name]?.result;
  if (results.database) {
    report.database = results.database;
    const db = report.database;
    if (!db.baseTablesPresent || db.database !== origin.database) block(new PreflightError("database_schema", "Database base schema or selected database identity does not match the rollout target."));
    if (!db.migrations.includes("0003_refresh_scheduler.sql")) report.pendingActions.push("Apply pending additive migrations before writer cutover.");
    else if (!["legacy", "queue_v1"].includes(db.writerGeneration)) block(new PreflightError("writer_state", "Scheduler migration exists without a valid writer-generation singleton."));
    if (db.writerGeneration !== "queue_v1") report.pendingActions.push("Switch legacy writer generation and reconcile after preparing the deployment.");
  }
  if (result("settings")) {
    const settings = result("settings"), bindings = settings.bindings ?? [];
    report.workerSettings = { compatibilityDate: settings.compatibility_date, usageModel: settings.usage_model,
      cpuMs: settings.limits?.cpu_ms, bindings: bindings.map(({ name, type, id }) => ({ name, type, ...(type === "hyperdrive" ? { id } : {}) })) };
    if (bindings.find((binding) => binding.name === "HYPERDRIVE")?.id !== CACHED_HYPERDRIVE) block(new PreflightError("cached_binding", "Live HYPERDRIVE does not match the recorded cached production binding."));
    const fresh = bindings.find((binding) => binding.name === "REFRESH_HYPERDRIVE");
    if (!fresh) report.pendingActions.push("Provision and bind the distinct cache-disabled REFRESH_HYPERDRIVE.");
    else if (fresh.id === CACHED_HYPERDRIVE) block(new PreflightError("refresh_binding", "Mutation Hyperdrive must differ from cached read Hyperdrive."));
  }
  if (result("deployments")) {
    report.deployments = (result("deployments").deployments ?? []).map(({ id, created_on, versions }) => ({ id, createdOn: created_on, versions }));
    if (!report.deployments.length) block(new PreflightError("rollback_version", "No active Worker deployment was found to capture for rollback."));
  }
  if (result("schedules")) report.schedules = (result("schedules").schedules ?? []).map(({ cron }) => cron);
  if (result("cachedHyperdrive")) {
    const config = result("cachedHyperdrive"), actual = config.origin;
    report.cachedHyperdrive = { id: config.id, cachingDisabled: config.caching?.disabled,
      origin: { host: actual?.host, port: actual?.port, database: actual?.database } };
    if (origin && (actual?.host?.toLowerCase() !== origin.host || Number(actual?.port ?? 5432) !== origin.port || actual?.database !== origin.database)) {
      block(new PreflightError("database_origin", "DATABASE_URL hostname, port, or database differs from the existing production Hyperdrive origin."));
    }
    if (config.caching?.disabled !== false) block(new PreflightError("cached_hyperdrive", "Existing production Hyperdrive is not confirmed cache-enabled."));
  }
  if (result("queues")) {
    report.queues = QUEUES.map((name) => {
      const queue = result("queues").find((item) => item.queue_name === name);
      if (!queue) report.pendingActions.push(`Create ${name} before deploying its consumer.`);
      return { name, present: Boolean(queue), id: queue?.queue_id, deliveryPaused: queue?.settings?.delivery_paused };
    });
  }
  return { ...report, ok: report.blockers.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(" ") === "--help") process.stdout.write(HELP);
  else if (process.argv.length > 2) { process.stderr.write(HELP); process.exitCode = 1; }
  else {
    const report = await runPreflight().catch(() => ({ ok: false, readOnly: true, activationReadiness: "not_assessed",
      blockers: [{ code: "preflight_response", message: "Unexpected preflight response; inspect the sanitized checks or retry. No mutations were attempted." }] }));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  }
}
