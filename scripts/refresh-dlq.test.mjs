import assert from "node:assert/strict";
import test from "node:test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVED_AT = "2026-08-16T20:00:00.000Z";

function validBody(overrides = {}) {
  return {
    version: 1,
    userId: USER_ID,
    claimId: CLAIM_ID,
    targetAt: "2026-08-16T12:00:00.000Z",
    enqueuedAt: "2026-08-16T12:00:00.000Z",
    ...overrides,
  };
}

function fakeMessage(body = validBody(), trace = []) {
  return {
    id: "dlq-message-1",
    body,
    attempts: 11,
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

  async recordInvalidMessage(queueMessageId, ids, observedAt) {
    this.calls.push(["recordInvalidMessage", queueMessageId, ids, observedAt]);
    if (this.options.error) throw this.options.error;
    this.options.trace?.push("commit");
  }

  async reconcileDeadLetter(queueMessageId, message, observedAt) {
    this.calls.push(["reconcileDeadLetter", queueMessageId, message, observedAt]);
    if (this.options.error) throw this.options.error;
    this.options.trace?.push("commit");
    return this.options.result ?? "committed";
  }
}

async function loadDlq() {
  return import("../src/lib/refresh-dlq.ts");
}

function consumeOptions({ message, repository, events } = {}) {
  return {
    message: message ?? fakeMessage(),
    repository: repository ?? new FakeRepository(),
    clock: () => OBSERVED_AT,
    logger: (event) => (events ?? []).push(event),
  };
}

test("valid dead letter commits reconciliation before ack", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const trace = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody(), trace);
  const result = await consumeDeadLetterMessage(consumeOptions({ message, repository }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.deepEqual(repository.calls, [[
    "reconcileDeadLetter",
    message.id,
    validBody(),
    OBSERVED_AT,
  ]]);
  assert.deepEqual(result, {
    received: 1,
    recorded: 1,
    staleClaim: 0,
    retried: 0,
    durationMs: result.durationMs,
  });
});

test("duplicate or replaced claim is acknowledged as stale after durable audit", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const trace = [];
  const repository = new FakeRepository({ trace, result: "stale" });
  const message = fakeMessage(validBody(), trace);
  const result = await consumeDeadLetterMessage(consumeOptions({ message, repository }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.equal(result.recorded, 1);
  assert.equal(result.staleClaim, 1);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
});

test("unsupported safe envelope persists invalid_message before logging and ack", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const trace = [];
  const events = [];
  const repository = new FakeRepository({ trace });
  const message = fakeMessage(validBody({ version: 2 }), trace);
  const result = await consumeDeadLetterMessage(consumeOptions({ message, repository, events }));

  assert.deepEqual(trace, ["commit", "ack"]);
  assert.deepEqual(repository.calls, [[
    "recordInvalidMessage",
    message.id,
    { userId: USER_ID, claimId: CLAIM_ID },
    OBSERVED_AT,
  ]]);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { event: events[0].event, queueMessageId: events[0].queueMessageId },
    { event: "refresh.message.invalid", queueMessageId: message.id },
  );
  assert.equal("body" in events[0], false);
  assert.equal(result.recorded, 1);
});

test("malformed dead letter logs only message ID and acknowledges without persistence", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const events = [];
  const repository = new FakeRepository();
  const message = fakeMessage({ token: "secret", graphql: "query Viewer" });
  const result = await consumeDeadLetterMessage(consumeOptions({ message, repository, events }));

  assert.equal(repository.calls.length, 0);
  assert.deepEqual(message.actions, [{ action: "ack" }]);
  assert.equal(events[0].event, "refresh.message.invalid");
  assert.deepEqual(Object.keys(events[0]).sort(), ["event", "eventId", "observedAt", "queueMessageId"]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(JSON.stringify(events).includes("query Viewer"), false);
  assert.equal(result.recorded, 0);
});

test("database outage retries the one DLQ message after two hours", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const trace = [];
  const repository = new FakeRepository({ error: new Error("postgres password"), trace });
  const message = fakeMessage(validBody(), trace);
  const events = [];
  const result = await consumeDeadLetterMessage(consumeOptions({ message, repository, events }));

  assert.deepEqual(trace, ["retry"]);
  assert.deepEqual(message.actions, [{ action: "retry", options: { delaySeconds: 7_200 } }]);
  assert.equal(result.retried, 1);
  assert.equal(events.length, 0);
});

test("unsupported audit outage retries without emitting a misleading invalid log", async () => {
  const { consumeDeadLetterMessage } = await loadDlq();
  const message = fakeMessage(validBody({ version: 9 }));
  const events = [];
  const result = await consumeDeadLetterMessage(consumeOptions({
    message,
    events,
    repository: new FakeRepository({ error: new Error("offline") }),
  }));

  assert.equal(result.retried, 1);
  assert.equal(events.length, 0);
  assert.deepEqual(message.actions, [{ action: "retry", options: { delaySeconds: 7_200 } }]);
});
