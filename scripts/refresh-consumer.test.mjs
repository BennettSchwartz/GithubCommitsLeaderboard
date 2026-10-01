import assert from "node:assert/strict";
import test from "node:test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_AT = "2026-08-16T12:00:00.000Z";
const ATTEMPTED_AT = "2026-08-16T12:00:02.000Z";

function validBody(overrides = {}) {
  return {
    version: 1,
    userId: USER_ID,
    claimId: CLAIM_ID,
    targetAt: TARGET_AT,
    enqueuedAt: TARGET_AT,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    userId: USER_ID,
    claimId: CLAIM_ID,
    targetAt: TARGET_AT,
    attemptedAt: ATTEMPTED_AT,
    startingCheckpoint: "2026-08-15T00:00:00.000Z",
    tokenUpdatedAt: "2026-08-15 00:00:00.123456+00",
    accessTokenEncrypted: "encrypted-dummy",
    githubCreatedAt: "2024-01-01T00:00:00.000Z",
    allTimeCommits: 40,
    failCount: 0,
    ...overrides,
  };
}

function fakeMessage(body = validBody(), attempts = 1, trace = []) {
  return {
    id: `queue-${attempts}`,
    body,
    attempts,
    actions: [],
    ack() {
      this.actions.push({ action: "ack" });
      trace.push("ack");
    },
    retry(options) {
      this.actions.push({ action: "retry", options });
      trace.push("retry");
    },
  };
}

class FakeRepository {
  constructor(options = {}) {
    this.options = options;
    this.calls = [];
  }

  async beginAttempt(message, requestedAttemptedAt) {
    this.calls.push(["beginAttempt", message, requestedAttemptedAt]);
    if (this.options.beginError) throw this.options.beginError;
    return this.options.beginResult === undefined ? snapshot() : this.options.beginResult;
  }

  async completeSuccess(value, total) {
    this.calls.push(["completeSuccess", value, total]);
    this.options.trace?.push("commit");
    if (this.options.successError) throw this.options.successError;
    return this.options.successResult ?? "committed";
  }

  async recordRetriableFailure(value, category) {
    this.calls.push(["recordRetriableFailure", value, category]);
    this.options.trace?.push("commit");
    if (this.options.retryError) throw this.options.retryError;
    return this.options.failureResult ?? "committed";
  }

  async recordAuthFailure(value) {
    this.calls.push(["recordAuthFailure", value]);
    this.options.trace?.push("commit");
    if (this.options.authError) throw this.options.authError;
    return this.options.failureResult ?? "committed";
  }

  async scheduleDeferredFailure(value, failure, nextRefreshAt) {
    this.calls.push(["scheduleDeferredFailure", value, failure, nextRefreshAt]);
    this.options.trace?.push("commit");
    if (this.options.deferredError) throw this.options.deferredError;
    return this.options.failureResult ?? "committed";
  }

  async recordInvalidMessage(queueMessageId, ids, observedAt) {
    this.calls.push(["recordInvalidMessage", queueMessageId, ids, observedAt]);
    this.options.trace?.push("commit");
    if (this.options.invalidError) throw this.options.invalidError;
  }
}

// Answers both query shapes a full recount can send: the aliased yearly query,
// or one window at a time after a resource-limit fallback. The aliased total
// lands in the first window so assertions can name the absolute score.
function allTimeSuccessFetch(total = 46) {
  const collection = (count) => ({
    totalCommitContributions: Math.max(count - 1, 0),
    restrictedContributionsCount: count > 0 ? 1 : 0,
  });
  return async (_url, init) => {
    const query = init ? JSON.parse(init.body).query : "";
    const aliases = [...query.matchAll(/(year\d+):/g)].map((match) => match[1]);
    const viewer = aliases.length === 0
      ? { contributionsCollection: collection(total) }
      : Object.fromEntries(aliases.map((alias, index) => [
        alias,
        collection(index === 0 ? total : 0),
      ]));
    return new Response(JSON.stringify({ data: { viewer } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function options({ message, repository, fetchImpl, decryptToken, events } = {}) {
  return {
    message: message ?? fakeMessage(),
    repository: repository ?? new FakeRepository(),
    decryptToken: decryptToken ?? (async () => "dummy-token"),
    fetchImpl: fetchImpl ?? allTimeSuccessFetch(),
    retryPolicy: { baseSeconds: 300, capSeconds: 3_600 },
    clock: () => ATTEMPTED_AT,
    logger: (event) => (events ?? []).push(event),
  };
}

async function loadConsumer() {
  return import("../src/lib/refresh-consumer.ts");
}

test("malformed body logs only the queue message ID and acknowledges", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const events = [];
  const repository = new FakeRepository();
  const message = fakeMessage("Bearer secret");
  const result = await consumeRefreshMessage(options({ message, repository, events }));

  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(repository.calls.length, 0);
  assert.deepEqual(result, {
    received: 1,
    refreshed: 0,
    terminal: 0,
    retried: 0,
    staleClaim: 0,
    githubRequestsUsed: 0,
    durationMs: result.durationMs,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "refresh.message.invalid");
  assert.equal(events[0].queueMessageId, message.id);
  assert.equal("body" in events[0], false);
  assert.equal("userId" in events[0], false);
  assert.equal("claimId" in events[0], false);
});

test("unsupported safe version commits invalid-message audit before ack", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody({ version: 2 }), 1, trace);
  const events = [];
  const result = await consumeRefreshMessage(options({ message, repository, events }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.deepEqual(repository.calls[0], [
    "recordInvalidMessage",
    message.id,
    { userId: USER_ID, claimId: CLAIM_ID },
    ATTEMPTED_AT,
  ]);
  assert.equal(events[0].event, "refresh.message.invalid");
  assert.equal(result.terminal, 0);
});

test("stale claim acknowledges without decrypting or fetching", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  let decrypted = false;
  let fetched = false;
  const message = fakeMessage();
  const result = await consumeRefreshMessage(options({
    message,
    repository: new FakeRepository({ beginResult: null }),
    decryptToken: async () => {
      decrypted = true;
      return "dummy-token";
    },
    fetchImpl: async () => {
      fetched = true;
      return new Response();
    },
  }));

  assert.equal(decrypted, false);
  assert.equal(fetched, false);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(result.staleClaim, 1);
});

test("successful CAS commits an absolute score before ack", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody(), 1, trace);
  const result = await consumeRefreshMessage(options({ message, repository }));

  assert.deepEqual(trace, ["commit", "ack"]);
  const completion = repository.calls.find(([name]) => name === "completeSuccess");
  assert.equal(completion[2], 46);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(result.refreshed, 1);
  assert.equal(result.githubRequestsUsed, 1);
});

test("duplicate delivery loses begin-attempt ownership and commits only once", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const repository = new FakeRepository();
  let begins = 0;
  repository.beginAttempt = async (message, attemptedAt) => {
    repository.calls.push(["beginAttempt", message, attemptedAt]);
    begins += 1;
    return begins === 1 ? snapshot() : null;
  };
  const first = fakeMessage();
  const duplicate = fakeMessage();

  await consumeRefreshMessage(options({ message: first, repository }));
  const duplicateResult = await consumeRefreshMessage(options({ message: duplicate, repository }));

  assert.equal(repository.calls.filter(([name]) => name === "completeSuccess").length, 1);
  assert.deepEqual(first.actions, [{ action: "ack" }]);
  assert.deepEqual(duplicate.actions, [{ action: "ack" }]);
  assert.equal(duplicateResult.staleClaim, 1);
});

test("401 marks reconnect and acknowledges only after the auth CAS", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody(), 1, trace);
  const events = [];
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    events,
    fetchImpl: async () => new Response("secret response", { status: 401 }),
  }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.equal(repository.calls.some(([name]) => name === "recordAuthFailure"), true);
  assert.equal(result.terminal, 1);
  assert.equal(events[0].event, "refresh.user.failed");
  assert.equal(events[0].category, "auth");
  assert.equal(events[0].retryScheduled, false);
  assert.equal(JSON.stringify(events).includes("secret response"), false);
});

test("replaced-token 401 loses the auth CAS and is acknowledged as stale", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const repository = new FakeRepository({ failureResult: "stale" });
  const message = fakeMessage();
  const events = [];
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    events,
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  }));

  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(result.staleClaim, 1);
  assert.equal(events.length, 0);
});

test("rate limit commits before the bounded Queue retry", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody(), 3, trace);
  const events = [];
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    events,
    fetchImpl: async () => new Response("limited", {
      status: 429,
      headers: { "retry-after": "30" },
    }),
  }));

  assert.deepEqual(trace, ["commit", "retry"]);
  assert.deepEqual(message.actions, [{ action: "retry", options: { delaySeconds: 1_200 } }]);
  assert.equal(repository.calls.at(-1)[0], "recordRetriableFailure");
  assert.equal(repository.calls.at(-1)[2], "rate_limit");
  assert.equal(result.retried, 1);
  assert.equal(events[0].retryScheduled, true);
});

test("upstream retries use the complete 300 600 1200 2400 3600 schedule", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const expected = [300, 600, 1_200, 2_400, 3_600];
  for (const [index, delaySeconds] of expected.entries()) {
    const message = fakeMessage(validBody(), index + 1);
    const repository = new FakeRepository();
    const result = await consumeRefreshMessage(options({
      message,
      repository,
      fetchImpl: async () => new Response("upstream body", { status: 503 }),
    }));
    assert.deepEqual(message.actions, [{ action: "retry", options: { delaySeconds } }]);
    assert.equal(repository.calls.at(-1)[2], "github_5xx");
    assert.equal(result.retried, 1);
  }
});

test("server wait over one hour persists a due time and acknowledges", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody(), 1, trace);
  const events = [];
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    events,
    fetchImpl: async () => new Response("limited", {
      status: 429,
      headers: { "retry-after": "7201" },
    }),
  }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.deepEqual(repository.calls.at(-1), [
    "scheduleDeferredFailure",
    snapshot(),
    { disposition: "retry", category: "rate_limit" },
    "2026-08-16T14:00:03.000Z",
  ]);
  assert.equal(result.retried, 1);
  assert.equal(events[0].retryScheduled, true);
});

test("network and platform failures map to transient retries with only platform defect logging", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  for (const [messageText, defectCode] of [
    ["socket closed", null],
    ["Too many subrequests", "platform_subrequest_limit"],
  ]) {
    const repository = new FakeRepository();
    const message = fakeMessage();
    const events = [];
    const result = await consumeRefreshMessage(options({
      message,
      repository,
      events,
      fetchImpl: async () => {
        throw new Error(messageText);
      },
    }));
    assert.equal(repository.calls.at(-1)[2], "github_transient");
    assert.equal(result.retried, 1);
    assert.equal(events.some((event) => event.event === "refresh.scheduler.defect"), defectCode !== null);
    if (defectCode) {
      assert.equal(events.find((event) => event.event === "refresh.scheduler.defect").defectCode, defectCode);
    }
    assert.equal(JSON.stringify(events).includes(messageText), false);
  }
});

test("canary retry policy uses two then four seconds", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  for (const [attempts, delaySeconds] of [[1, 2], [2, 4]]) {
    const message = fakeMessage(validBody(), attempts);
    await consumeRefreshMessage({
      ...options({
        message,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
      retryPolicy: { baseSeconds: 2, capSeconds: 4 },
    });
    assert.deepEqual(message.actions, [{ action: "retry", options: { delaySeconds } }]);
  }
});

test("request-budget exhaustion becomes a terminal defect without a yearly fetch", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const repository = new FakeRepository({
    beginResult: snapshot({
      startingCheckpoint: null,
      githubCreatedAt: "1980-01-01T00:00:00.000Z",
    }),
  });
  const events = [];
  let fetches = 0;
  const message = fakeMessage();
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    events,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        errors: [{ type: "MAX_COMPLEXITY", message: "untrusted detail" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  }));

  assert.equal(fetches, 1);
  assert.equal(result.terminal, 1);
  assert.equal(result.githubRequestsUsed, 1);
  const defect = events.find((event) => event.event === "refresh.scheduler.defect");
  assert.equal(defect.defectCode, "request_budget_exhausted");
  assert.equal(defect.category, "github_terminal");
  assert.equal(JSON.stringify(events).includes("untrusted detail"), false);
});

test("old-account resource fallback performs at most 40 GitHub requests", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const repository = new FakeRepository({
    beginResult: snapshot({
      startingCheckpoint: null,
      githubCreatedAt: "1988-01-01T00:00:00.000Z",
      allTimeCommits: 0,
    }),
  });
  let fetches = 0;
  const message = fakeMessage();
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) {
        return new Response(JSON.stringify({
          errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "detail" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return allTimeSuccessFetch(1)();
    },
  }));

  assert.equal(fetches, 40);
  assert.equal(result.githubRequestsUsed, 40);
  assert.equal(result.refreshed, 1);
  assert.equal(repository.calls.find(([name]) => name === "completeSuccess")[2], 39);
});

test("non-rate 403 schedules a terminal retry time and acknowledges", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const repository = new FakeRepository();
  const message = fakeMessage();
  const result = await consumeRefreshMessage(options({
    message,
    repository,
    fetchImpl: async () => new Response("forbidden detail", { status: 403 }),
  }));

  assert.deepEqual(repository.calls.at(-1), [
    "scheduleDeferredFailure",
    snapshot(),
    { disposition: "terminal", category: "github_terminal" },
    "2026-08-17T12:00:02.000Z",
  ]);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(result.terminal, 1);
});

test("database transition failure retries without claiming a commit", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const events = [];
  const message = fakeMessage();
  const result = await consumeRefreshMessage(options({
    message,
    events,
    repository: new FakeRepository({ successError: new Error("database DSN secret") }),
  }));

  assert.deepEqual(message.actions, [{ action: "retry", options: undefined }]);
  assert.equal(result.retried, 1);
  assert.equal(events.at(-1).event, "refresh.user.failed");
  assert.equal(events.at(-1).category, "database");
  assert.equal(JSON.stringify(events).includes("database DSN secret"), false);
});

test("begin-attempt database failure emits only sanitized failure evidence and retries", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const message = fakeMessage();
  const events = [];
  const result = await consumeRefreshMessage(options({
    message,
    events,
    repository: new FakeRepository({ beginError: new Error("postgresql://secret") }),
  }));

  assert.equal(result.retried, 1);
  assert.deepEqual(message.actions, [{ action: "retry", options: undefined }]);
  assert.equal(events[0].event, "refresh.user.failed");
  assert.equal(events[0].category, "database");
  assert.equal(JSON.stringify(events).includes("postgresql://secret"), false);
});

test("unknown per-user failure records a matched retry and does not stop a later healthy message", async () => {
  const { consumeRefreshMessage } = await loadConsumer();
  const failingRepository = new FakeRepository();
  const failed = fakeMessage();
  const failedResult = await consumeRefreshMessage(options({
    message: failed,
    repository: failingRepository,
    decryptToken: async () => {
      throw new Error("bad local ciphertext detail");
    },
  }));
  const healthy = fakeMessage(validBody({
    userId: "33333333-3333-4333-8333-333333333333",
    claimId: "44444444-4444-4444-8444-444444444444",
  }));
  const healthyRepository = new FakeRepository({
    beginResult: snapshot({
      userId: healthy.body.userId,
      claimId: healthy.body.claimId,
    }),
  });
  const healthyResult = await consumeRefreshMessage(options({
    message: healthy,
    repository: healthyRepository,
  }));

  assert.equal(failingRepository.calls.at(-1)[2], "unknown");
  assert.equal(failedResult.retried, 1);
  assert.equal(healthyResult.refreshed, 1);
  assert.deepEqual(healthy.actions, [{ action: "ack" }]);
});

test("structured log schema rejects missing extra and cross-variant fields", async () => {
  const {
    createRefreshLogger,
    createRefreshLogEvent,
    parseRefreshLogEvent,
  } = await import("../src/lib/refresh-log.ts");
  const base = {
    event: "refresh.message.invalid",
    observedAt: ATTEMPTED_AT,
    queueMessageId: "queue-1",
  };
  const event = createRefreshLogEvent(base);
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(parseRefreshLogEvent(event), event);
  assert.throws(() => parseRefreshLogEvent({ ...event, eventId: undefined }));
  assert.throws(() => parseRefreshLogEvent({ ...event, accessToken: "secret" }));
  assert.throws(() => parseRefreshLogEvent({ ...event, userId: USER_ID }));
  assert.notEqual(createRefreshLogEvent(base).eventId, event.eventId);
  const lines = [];
  const logger = createRefreshLogger((line) => lines.push(line));
  logger(event);
  assert.deepEqual(JSON.parse(lines[0]), event);
  assert.throws(() => logger({ ...event, rawException: "secret" }));
});
