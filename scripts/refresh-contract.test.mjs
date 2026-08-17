import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_LEASE_MS,
  CLAIM_PAGE_SIZE,
  DLQ_MAX_RETRIES,
  DLQ_QUEUE_NAME,
  DLQ_RETRY_DELAY_SECONDS,
  GITHUB_REQUEST_LIMIT,
  PRIMARY_MAX_RETRIES,
  PRIMARY_QUEUE_NAME,
  QUEUE_SEND_BATCH_SIZE,
  REFRESH_INTERVAL_MS,
  TERMINAL_RETRY_MS,
  computePrimaryRetryDelay,
  parseRefreshMessage,
  projectWorstCaseQueueOperations,
  resolveRetryPolicy,
} from "../src/lib/refresh-contract.ts";

const valid = {
  version: 1,
  userId: "11111111-1111-4111-8111-111111111111",
  claimId: "22222222-2222-4222-8222-222222222222",
  targetAt: "2026-08-16T12:00:00.000Z",
  enqueuedAt: "2026-08-16T12:00:01.000Z",
};

test("locks approved scheduler limits", () => {
  assert.equal(REFRESH_INTERVAL_MS, 60 * 60 * 60 * 1000);
  assert.equal(CLAIM_LEASE_MS, 8 * 60 * 60 * 1000);
  assert.equal(CLAIM_PAGE_SIZE, 300);
  assert.equal(QUEUE_SEND_BATCH_SIZE, 100);
  assert.equal(GITHUB_REQUEST_LIMIT, 40);
  assert.equal(PRIMARY_QUEUE_NAME, "githubcommits-refresh");
  assert.equal(DLQ_QUEUE_NAME, "githubcommits-refresh-dlq");
  assert.equal(DLQ_MAX_RETRIES, 10);
  assert.equal(DLQ_RETRY_DELAY_SECONDS, 7200);
  assert.equal(TERMINAL_RETRY_MS, 24 * 60 * 60 * 1000);
});

test("accepts only the versioned identifier-only message", () => {
  assert.deepEqual(parseRefreshMessage(valid), { kind: "valid", message: valid });
  assert.equal(parseRefreshMessage({ ...valid, accessToken: "secret" }).kind, "unparseable");
  assert.equal(parseRefreshMessage({ ...valid, targetAt: "not-a-time" }).kind, "unparseable");
  assert.equal(parseRefreshMessage({ ...valid, userId: "not-a-uuid" }).kind, "unparseable");
});

test("separates safe unsupported versions from unparseable bodies", () => {
  assert.deepEqual(parseRefreshMessage({ ...valid, version: 2 }), {
    kind: "unsupported",
    messageIdFields: { userId: valid.userId, claimId: valid.claimId },
  });
  assert.deepEqual(parseRefreshMessage("Bearer secret"), { kind: "unparseable" });
  assert.deepEqual(parseRefreshMessage({ ...valid, version: 2, extra: true }), { kind: "unparseable" });
  assert.deepEqual(parseRefreshMessage({ ...valid, version: 1.5 }), { kind: "unparseable" });
});

test("uses bounded exponential retries covered by the lease", () => {
  const production = { baseSeconds: 300, capSeconds: 3600 };
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => computePrimaryRetryDelay(attempt, production)),
    [300, 600, 1200, 2400, 3600],
  );
  const totalDelayMs = [1, 2, 3, 4, 5]
    .map((attempt) => computePrimaryRetryDelay(attempt, production))
    .reduce((sum, seconds) => sum + seconds * 1000, 0);
  assert.equal(PRIMARY_MAX_RETRIES, 5);
  assert.ok(totalDelayMs < CLAIM_LEASE_MS);
});

test("allows retry overrides only for the isolated canary", () => {
  assert.deepEqual(resolveRetryPolicy({}), { baseSeconds: 300, capSeconds: 3600 });
  assert.deepEqual(
    resolveRetryPolicy({
      REFRESH_PRIMARY_QUEUE_NAME: "githubcommits-refresh-canary-20260816",
      REFRESH_RETRY_BASE_SECONDS: "2",
      REFRESH_RETRY_CAP_SECONDS: "4",
    }),
    { baseSeconds: 2, capSeconds: 4 },
  );
  assert.throws(
    () => resolveRetryPolicy({ REFRESH_RETRY_BASE_SECONDS: "2", REFRESH_RETRY_CAP_SECONDS: "4" }),
    /invalid refresh retry override/,
  );
  assert.throws(
    () =>
      resolveRetryPolicy({
        REFRESH_PRIMARY_QUEUE_NAME: "githubcommits-refresh-canary-20260816",
        REFRESH_RETRY_BASE_SECONDS: "2",
      }),
    /invalid refresh retry override/,
  );
});

test("prices a primary-plus-DLQ exhaustion conservatively", () => {
  assert.ok(Buffer.byteLength(JSON.stringify(valid), "utf8") + 100 < 64 * 1024);
  assert.equal(projectWorstCaseQueueOperations(300), 6900);
  assert.equal(projectWorstCaseQueueOperations(6), 138);
});

test("rejects invalid retry and projection arithmetic", () => {
  assert.throws(() => computePrimaryRetryDelay(0, { baseSeconds: 300, capSeconds: 3600 }), /attempts/);
  assert.throws(() => computePrimaryRetryDelay(1, { baseSeconds: 0, capSeconds: 3600 }), /policy/);
  assert.throws(() => projectWorstCaseQueueOperations(-1), /messageCount/);
  assert.throws(() => projectWorstCaseQueueOperations(Number.MAX_SAFE_INTEGER), /safe integer/);
});
