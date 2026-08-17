import assert from "node:assert/strict";
import test from "node:test";

import {
  OnboardingConnectionChangedError,
  OnboardingTokenChangedError,
  RefreshResultUnavailableError,
  runOnboardingRefresh,
} from "../src/lib/onboarding-refresh.ts";
import { authorizeAndEnqueueRefresh } from "../src/lib/refresh-http.ts";
import {
  routeRefreshQueueBatch,
  runScheduledRefresh,
} from "../src/lib/refresh-worker.ts";
import { parseObservedAt } from "./reconcile-refresh-cutover.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CLAIM_ID = "00000000-0000-4000-8000-000000000002";
const TARGET = "2026-08-16T12:00:00.000Z";
const PRIOR = "2026-08-15T12:00:00.000Z";

function snapshot(overrides = {}) {
  return {
    userId: USER_ID,
    targetAt: TARGET,
    startingCheckpoint: PRIOR,
    tokenUpdatedAt: "2026-08-15T00:00:00.000Z",
    accessTokenEncrypted: "encrypted-token",
    githubCreatedAt: "2024-01-01T00:00:00.000Z",
    allTimeCommits: 40,
    ...overrides,
  };
}

const committed = {
  userId: USER_ID,
  allTimeCommits: 47,
  checkedAt: TARGET,
  rank: 3,
  totalUsers: 100,
  percentile: 98,
};

function contributionResponse(publicCommits = 5, privateCommits = 2) {
  return new Response(
    JSON.stringify({
      data: {
        viewer: {
          contributionsCollection: {
            totalCommitContributions: publicCommits,
            restrictedContributionsCount: privateCommits,
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function onboardingHarness({ begins, outcomes = [], loaded = [committed] }) {
  const calls = {
    begin: 0,
    complete: [],
    decrypt: [],
    fetch: 0,
    progress: [],
    load: 0,
  };
  const beginQueue = [...begins];
  const outcomeQueue = [...outcomes];
  const loadedQueue = [...loaded];
  const repository = {
    async beginOnboardingAttempt() {
      calls.begin += 1;
      return beginQueue.shift();
    },
    async completeOnboardingSuccess(value, total) {
      calls.complete.push({ snapshot: value, total });
      return outcomeQueue.shift();
    },
    async loadCommittedRefreshResult() {
      calls.load += 1;
      return loadedQueue.shift() ?? null;
    },
  };
  const deps = {
    repository,
    async decryptToken(value) {
      calls.decrypt.push(value);
      return `plain:${value}`;
    },
    async fetchImpl() {
      calls.fetch += 1;
      return contributionResponse();
    },
    clock: () => TARGET,
    logger() {},
  };
  const input = {
    userId: USER_ID,
    targetAt: TARGET,
    onProgress(event) {
      calls.progress.push(event);
    },
  };
  return { calls, deps, input };
}

test("initial checkpoint at target returns stored winner without fetch", async () => {
  const harness = onboardingHarness({
    begins: [
      {
        kind: "ready",
        snapshot: snapshot({ startingCheckpoint: TARGET }),
      },
    ],
  });
  assert.deepEqual(
    await runOnboardingRefresh(harness.input, harness.deps),
    committed,
  );
  assert.equal(harness.calls.fetch, 0);
  assert.deepEqual(harness.calls.decrypt, []);
  assert.deepEqual(harness.calls.complete, []);
});

test("committed onboarding returns the stored database result", async () => {
  const harness = onboardingHarness({
    begins: [{ kind: "ready", snapshot: snapshot() }],
    outcomes: ["committed"],
  });
  const result = await runOnboardingRefresh(harness.input, harness.deps);
  assert.deepEqual(result, committed);
  assert.equal(harness.calls.complete[0].total, 47);
  assert.deepEqual(harness.calls.progress, [
    {
      window: 1,
      total: 1,
      commitsSoFar: 40,
      yearLabel: "Updating...",
    },
  ]);
});

test("stale winner returns the same stored result", async () => {
  const harness = onboardingHarness({
    begins: [{ kind: "ready", snapshot: snapshot() }],
    outcomes: ["stale_winner"],
  });
  assert.strictEqual(
    await runOnboardingRefresh(harness.input, harness.deps),
    committed,
  );
});

test("missing committed result fails without SSE complete", async () => {
  const harness = onboardingHarness({
    begins: [{ kind: "ready", snapshot: snapshot() }],
    outcomes: ["committed"],
    loaded: [null],
  });
  await assert.rejects(
    runOnboardingRefresh(harness.input, harness.deps),
    RefreshResultUnavailableError,
  );
});

test("token rotation during onboarding refetches exactly once", async () => {
  const first = snapshot({ accessTokenEncrypted: "old-token" });
  const second = snapshot({
    targetAt: "2026-08-16T12:01:00.000Z",
    accessTokenEncrypted: "new-token",
    tokenUpdatedAt: "2026-08-16T12:00:30.000Z",
  });
  const harness = onboardingHarness({
    begins: [
      { kind: "ready", snapshot: first },
      { kind: "ready", snapshot: second },
    ],
    outcomes: ["stale_token", "committed"],
  });
  assert.deepEqual(
    await runOnboardingRefresh(harness.input, harness.deps),
    committed,
  );
  assert.deepEqual(harness.calls.decrypt, ["old-token", "new-token"]);
  assert.equal(harness.calls.fetch, 2);
  assert.strictEqual(harness.calls.complete[1].snapshot, second);
});

test("queue winner during token retry returns newer checkpoint without refetch", async () => {
  const harness = onboardingHarness({
    begins: [
      { kind: "ready", snapshot: snapshot({ accessTokenEncrypted: "old" }) },
      {
        kind: "ready",
        snapshot: snapshot({
          targetAt: "2026-08-16T12:01:00.000Z",
          startingCheckpoint: "2026-08-16T12:01:00.000Z",
          accessTokenEncrypted: "new",
        }),
      },
    ],
    outcomes: ["stale_token"],
  });
  assert.deepEqual(
    await runOnboardingRefresh(harness.input, harness.deps),
    committed,
  );
  assert.equal(harness.calls.fetch, 1);
  assert.deepEqual(harness.calls.decrypt, ["old"]);
  assert.equal(harness.calls.complete.length, 1);
});

test("auth reconnect during onboarding returns a connection-changed error", async () => {
  const harness = onboardingHarness({ begins: [{ kind: "reconnect" }] });
  await assert.rejects(
    runOnboardingRefresh(harness.input, harness.deps),
    OnboardingConnectionChangedError,
  );
  assert.equal(harness.calls.fetch, 0);
  assert.equal(harness.calls.load, 0);
});

test("a second token rotation fails without SSE complete", async () => {
  const harness = onboardingHarness({
    begins: [
      { kind: "ready", snapshot: snapshot({ accessTokenEncrypted: "one" }) },
      { kind: "ready", snapshot: snapshot({ accessTokenEncrypted: "two" }) },
    ],
    outcomes: ["stale_token", "stale_token"],
  });
  await assert.rejects(
    runOnboardingRefresh(harness.input, harness.deps),
    OnboardingTokenChangedError,
  );
  assert.equal(harness.calls.fetch, 2);
  assert.equal(harness.calls.load, 0);
});

test("manual authorization never claims without the exact bearer secret", async () => {
  let claims = 0;
  const deps = {
    repository: {
      async claimDueUsers() {
        claims += 1;
        return { targetAt: TARGET, enqueuedAt: TARGET, claims: [] };
      },
      async releaseClaims() {
        return 0;
      },
    },
    queue: { async sendBatch() {} },
    clock: () => TARGET,
    logger() {},
  };

  assert.deepEqual(
    await authorizeAndEnqueueRefresh(
      { authorization: null, expectedSecret: "secret", targetAt: TARGET },
      deps,
    ),
    { status: 401, body: { error: "Unauthorized" } },
  );
  assert.deepEqual(
    await authorizeAndEnqueueRefresh(
      { authorization: "Bearer wrong", expectedSecret: "secret", targetAt: TARGET },
      deps,
    ),
    { status: 401, body: { error: "Unauthorized" } },
  );
  assert.equal(claims, 0);

  assert.deepEqual(
    await authorizeAndEnqueueRefresh(
      {
        authorization: "Bearer secret",
        expectedSecret: "secret",
        targetAt: TARGET,
      },
      deps,
    ),
    { status: 200, body: { claimed: 0, enqueued: 0, released: 0 } },
  );
  assert.equal(claims, 1);
});

test("manual producer envelopes contain identifiers only", async () => {
  const sent = [];
  const deps = {
    repository: {
      async claimDueUsers() {
        return {
          targetAt: TARGET,
          enqueuedAt: TARGET,
          claims: [
            {
              userId: USER_ID,
              claimId: CLAIM_ID,
              dueAt: PRIOR,
              message: {
                version: 1,
                userId: USER_ID,
                claimId: CLAIM_ID,
                targetAt: TARGET,
                enqueuedAt: TARGET,
              },
            },
          ],
        };
      },
      async releaseClaims() {
        return 0;
      },
    },
    queue: {
      async sendBatch(messages) {
        sent.push(...messages);
      },
    },
    clock: () => TARGET,
    logger() {},
  };
  const result = await authorizeAndEnqueueRefresh(
    {
      authorization: "Bearer secret",
      expectedSecret: "secret",
      targetAt: TARGET,
    },
    deps,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(sent[0].body).sort(), [
    "claimId",
    "enqueuedAt",
    "targetAt",
    "userId",
    "version",
  ]);
});

test("runScheduledRefresh uses the invocation clock", async () => {
  const invocationAt = "2026-08-16T12:00:00.000Z";
  const databaseTargetAt = "2026-08-16T12:00:00.010Z";
  const clockValues = [
    invocationAt,
    "2026-08-16T12:00:00.001Z",
    "2026-08-16T12:00:00.002Z",
    "2026-08-16T12:00:00.003Z",
    "2026-08-16T12:00:00.004Z",
  ];
  const claims = [];
  const events = [];

  const result = await runScheduledRefresh(
    {},
    {
      repository: {
        async claimDueUsers(requestedTargetAt, requestedEnqueuedAt, limit) {
          claims.push({ requestedTargetAt, requestedEnqueuedAt, limit });
          return {
            targetAt: databaseTargetAt,
            enqueuedAt: requestedEnqueuedAt,
            claims: [],
          };
        },
      },
      queue: {
        async sendBatch() {
          assert.fail("an empty claim page must not send a Queue batch");
        },
      },
      clock() {
        return clockValues.shift();
      },
      logger(event) {
        events.push(event);
      },
    },
  );

  assert.deepEqual(claims, [
    {
      requestedTargetAt: invocationAt,
      requestedEnqueuedAt: "2026-08-16T12:00:00.002Z",
      limit: 300,
    },
  ]);
  assert.equal(result.targetAt, databaseTargetAt);
  assert.equal(events[0].event, "refresh.producer.completed");
});

test("runScheduledRefresh propagates producer failure", async () => {
  const failure = new Error("database unavailable");
  const events = [];
  const clockValues = [
    TARGET,
    "2026-08-16T12:00:00.001Z",
    "2026-08-16T12:00:00.002Z",
    "2026-08-16T12:00:00.003Z",
  ];
  const pending = runScheduledRefresh(
    {},
    {
      repository: {
        async claimDueUsers() {
          throw failure;
        },
      },
      queue: { async sendBatch() {} },
      clock() {
        return clockValues.shift();
      },
      logger(event) {
        events.push(event);
      },
    },
  );

  await assert.rejects(pending, (error) => error === failure);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "refresh.producer.failed");
  assert.equal(events[0].targetAt, TARGET);
});

function queueRouteDependencies() {
  const events = [];
  const repository = {};
  return {
    events,
    deps: {
      primary: {
        repository,
        async decryptToken() {
          throw new Error("empty batches must not decrypt a token");
        },
        async fetchImpl() {
          throw new Error("empty batches must not call GitHub");
        },
        retryPolicy: { baseSeconds: 300, capSeconds: 3600 },
        clock: () => TARGET,
        logger(event) {
          events.push(event);
        },
      },
      dlq: {
        repository,
        clock: () => TARGET,
        logger(event) {
          events.push(event);
        },
      },
    },
  };
}

test("routeRefreshQueueBatch uses production defaults and routes the DLQ", async () => {
  const { deps } = queueRouteDependencies();

  assert.equal(
    (
      await routeRefreshQueueBatch(
        { queue: "githubcommits-refresh", messages: [] },
        {},
        deps,
      )
    ).queue,
    "primary",
  );
  assert.equal(
    (
      await routeRefreshQueueBatch(
        { queue: "githubcommits-refresh-dlq", messages: [] },
        {},
        deps,
      )
    ).queue,
    "dlq",
  );
});

test("routeRefreshQueueBatch honors isolated canary queue overrides", async () => {
  const { deps } = queueRouteDependencies();
  const env = {
    REFRESH_PRIMARY_QUEUE_NAME: "githubcommits-refresh-canary-20260816",
    REFRESH_DLQ_NAME: "githubcommits-refresh-dlq-canary-20260816",
  };

  assert.equal(
    (
      await routeRefreshQueueBatch(
        { queue: env.REFRESH_PRIMARY_QUEUE_NAME, messages: [] },
        env,
        deps,
      )
    ).queue,
    "primary",
  );
  assert.equal(
    (
      await routeRefreshQueueBatch(
        { queue: env.REFRESH_DLQ_NAME, messages: [] },
        env,
        deps,
      )
    ).queue,
    "dlq",
  );
});

test("routeRefreshQueueBatch rejects an unknown queue", async () => {
  const { deps } = queueRouteDependencies();
  await assert.rejects(
    routeRefreshQueueBatch(
      { queue: "githubcommits-refresh-unknown", messages: [] },
      {},
      deps,
    ),
    /Unknown refresh queue/,
  );
});

test("parseObservedAt accepts exactly one offset ISO timestamp", () => {
  const observedAt = "2026-08-16T12:34:56.789+05:30";
  assert.equal(
    parseObservedAt(["--observed-at", observedAt]),
    observedAt,
  );
});

test("parseObservedAt rejects malformed timestamps and extra arguments", () => {
  const invalidArguments = [
    [],
    ["--observed-at"],
    ["--observed-at", "2026-08-16T12:34:56.789"],
    ["--observed-at", "2026-02-30T12:34:56.789Z"],
    ["--observed-at", TARGET, "unexpected"],
    ["--wrong-flag", TARGET],
  ];

  for (const argv of invalidArguments) {
    assert.throws(() => parseObservedAt(argv));
  }
});
