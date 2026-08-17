import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

const ROOT = new URL("../", import.meta.url);

const EXPECTED_QUEUES = {
  producers: [
    {
      binding: "REFRESH_QUEUE",
      queue: "githubcommits-refresh",
    },
  ],
  consumers: [
    {
      queue: "githubcommits-refresh",
      max_batch_size: 1,
      max_batch_timeout: 5,
      max_retries: 5,
      dead_letter_queue: "githubcommits-refresh-dlq",
      max_concurrency: 2,
      retry_delay: 300,
    },
    {
      queue: "githubcommits-refresh-dlq",
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 10,
      max_concurrency: 1,
      retry_delay: 7200,
    },
  ],
};

const REQUIRED_SECRETS = [
  "CRON_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
];

function loadJsonc(relativePath) {
  const url = new URL(relativePath, ROOT);
  const text = readFileSync(url, "utf8");
  const parsed = ts.parseConfigFileTextToJson(url.pathname, text);

  if (parsed.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    );
  }

  return parsed.config;
}

function assertProductionConfig(config) {
  assert.equal(config.name, "githubcommitsleaderboard");
  assert.equal(config.main, "worker.ts");
  assert.equal(config.compatibility_date, "2026-03-02");
  assert.deepEqual(config.compatibility_flags, [
    "nodejs_compat",
    "global_fetch_strictly_public",
  ]);
  assert.deepEqual(config.observability, { enabled: true });
  assert.deepEqual(config.limits, { cpu_ms: 30000 });
  assert.equal(config.preview_urls, true);
  assert.ok(
    config.upload_source_maps === undefined || config.upload_source_maps === false,
    "production source-map upload must remain disabled",
  );
  assert.ok(
    config.assets?.run_worker_first === undefined ||
      config.assets.run_worker_first === false,
    "assets must not run before the Worker",
  );
  assert.deepEqual(config.triggers, { crons: ["0 * * * *"] });
  assert.deepEqual(config.queues, EXPECTED_QUEUES);
  assert.deepEqual(config.secrets, { required: REQUIRED_SECRETS });

  assert.deepEqual(config.hyperdrive, [
    {
      binding: "HYPERDRIVE",
      id: "aee89c7b5b11441c9ea84decaaab2a08",
    },
  ]);
  assert.equal(
    config.hyperdrive.some((binding) => binding.binding === "REFRESH_HYPERDRIVE"),
    false,
  );
  assert.equal(config.vars?.GITHUB_GRAPHQL_ENDPOINT, undefined);
  assert.equal(config.vars?.REFRESH_PRIMARY_QUEUE_NAME, undefined);
  assert.equal(config.vars?.REFRESH_DLQ_NAME, undefined);
  assert.equal(config.vars?.REFRESH_RETRY_BASE_SECONDS, undefined);
  assert.equal(config.vars?.REFRESH_RETRY_CAP_SECONDS, undefined);
}

test("production Worker config pins the scheduler runtime contract", () => {
  assertProductionConfig(loadJsonc("wrangler.jsonc"));
});

test("production Worker config validation fails closed on scheduler drift", () => {
  const valid = loadJsonc("wrangler.jsonc");
  const cases = [
    ["producer", (value) => value.queues.producers.splice(0)],
    ["primary consumer", (value) => value.queues.consumers.splice(0, 1)],
    ["DLQ consumer", (value) => value.queues.consumers.splice(1, 1)],
    ["consumer retry", (value) => (value.queues.consumers[0].max_retries = 4)],
    ["cron", (value) => (value.triggers.crons = [])],
    ["CPU limit", (value) => delete value.limits.cpu_ms],
    ["observability", (value) => (value.observability.enabled = false)],
    ["preview", (value) => (value.preview_urls = false)],
    ["secret inventory", (value) => value.secrets.required.pop()],
    [
      "fresh Hyperdrive",
      (value) =>
        value.hyperdrive.push({
          binding: "REFRESH_HYPERDRIVE",
          id: "invented-production-id",
        }),
    ],
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(
      () => assertProductionConfig(candidate),
      undefined,
      `${label} drift must be rejected`,
    );
  }
});

test("worker TypeScript gate includes the adapter and generated bindings", () => {
  assert.deepEqual(loadJsonc("tsconfig.worker.json"), {
    extends: "./tsconfig.json",
    compilerOptions: {
      incremental: false,
      noEmit: true,
      plugins: [],
      types: ["node"],
      lib: ["ES2024", "DOM", "DOM.Iterable"],
    },
    include: [
      "worker.ts",
      "worker-configuration.d.ts",
      "src/lib/postgres.ts",
      "src/lib/runtime-env.ts",
      "src/lib/refresh-*.ts",
      "src/lib/github-refresh.ts",
      "src/lib/onboarding-refresh.ts",
    ],
    exclude: ["node_modules", ".next", ".open-next"],
  });
});

test("generated bindings expose Queue, cached Hyperdrive, and reviewed vars", () => {
  const declarations = readFileSync(
    new URL("worker-configuration.d.ts", ROOT),
    "utf8",
  );

  assert.match(
    declarations,
    /interface CloudflareEnv extends Cloudflare\.Env\s*{}/,
  );
  assert.match(declarations, /REFRESH_QUEUE:\s*Queue/);
  assert.match(declarations, /HYPERDRIVE:\s*Hyperdrive/);
  assert.doesNotMatch(declarations, /REFRESH_HYPERDRIVE:/);
  assert.match(declarations, /APP_URL:\s*"https:\/\/ghcommits\.com"/);
  assert.match(
    declarations,
    /NEXT_PUBLIC_REPOSITORY_URL:\s*"https:\/\/github\.com\/BennettSchwartz\/GithubCommitsLeaderboard"/,
  );
});
