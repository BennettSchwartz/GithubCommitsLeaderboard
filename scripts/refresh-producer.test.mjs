import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const TARGET_AT = "2026-08-16T12:00:00.000Z";

function uuid(index, namespace = "1000") {
  return `${namespace}0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function makeClaims(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const position = offset + index + 1;
    const userId = uuid(position, "1000");
    const claimId = uuid(position, "2000");
    return {
      userId,
      claimId,
      dueAt: new Date(Date.parse(TARGET_AT) - position * 1_000).toISOString(),
      message: {
        version: 1,
        userId,
        claimId,
        targetAt: TARGET_AT,
        enqueuedAt: TARGET_AT,
      },
    };
  });
}

class ClaimRepository {
  constructor(claims) {
    this.available = [...claims];
    this.claimed = new Map();
    this.releasedUserIds = [];
  }

  async claimDueUsers(_targetAt, _enqueuedAt, limit) {
    const claims = this.available.splice(0, limit);
    for (const claim of claims) this.claimed.set(claim.claimId, claim);
    return { targetAt: TARGET_AT, enqueuedAt: TARGET_AT, claims };
  }

  async releaseClaims(messages) {
    let released = 0;
    for (const message of messages) {
      const claim = this.claimed.get(message.claimId);
      if (claim?.userId !== message.userId) continue;
      this.claimed.delete(message.claimId);
      this.releasedUserIds.push(message.userId);
      released += 1;
    }
    return released;
  }

  get stillClaimedCount() {
    return this.claimed.size;
  }
}

class RecordingQueue {
  constructor({ failAt = null, acceptBeforeFailure = false } = {}) {
    this.failAt = failAt;
    this.acceptBeforeFailure = acceptBeforeFailure;
    this.batchSizes = [];
    this.accepted = [];
  }

  async sendBatch(entries) {
    this.batchSizes.push(entries.length);
    const call = this.batchSizes.length;
    if (call === this.failAt) {
      if (this.acceptBeforeFailure) this.accepted.push(...entries.map(({ body }) => body));
      throw new Error("synthetic queue response loss");
    }
    this.accepted.push(...entries.map(({ body }) => body));
  }
}

async function loadProducer() {
  return import("../src/lib/refresh-producer.ts");
}

test("legacy direct refresh repeats the same first-50 GitHub-ID prefix", async () => {
  const users = Array.from({ length: 325 }, (_, index) => ({
    githubId: index + 1,
    userId: uuid(index + 1),
  }));

  async function runLegacyOnce() {
    const updated = [];
    let requests = 0;
    await assert.rejects(async () => {
      for (const user of [...users].sort((left, right) => left.githubId - right.githubId)) {
        requests += 1;
        if (requests === 51) throw new Error("external subrequest limit");
        updated.push(user.userId);
      }
    }, /external subrequest limit/);
    return updated;
  }

  const first = await runLegacyOnce();
  const second = await runLegacyOnce();
  assert.equal(first.length, 50);
  assert.deepEqual(second, first);
  assert.deepEqual(first, users.slice(0, 50).map(({ userId }) => userId));
  assert.equal(first.includes(users[50].userId), false);
  assert.equal(first.includes(users[324].userId), false);
});

test("queued producers cross the legacy prefix in sequential 100-message chunks", async () => {
  const { enqueueDueRefreshes } = await loadProducer();
  const claims = makeClaims(325);
  const repository = new ClaimRepository(claims);
  const queue = new RecordingQueue();
  const options = {
    repository,
    queue,
    targetAt: TARGET_AT,
    source: "cron",
    clock: () => TARGET_AT,
  };

  const first = await enqueueDueRefreshes(options);
  const second = await enqueueDueRefreshes(options);

  assert.deepEqual(queue.batchSizes, [100, 100, 100, 25]);
  assert.deepEqual([first.claimed, second.claimed], [300, 25]);
  assert.equal(queue.accepted.length, 325);
  assert.equal(new Set(queue.accepted.map(({ userId }) => userId)).size, 325);
  assert.equal(queue.accepted[50].userId, claims[50].userId);
  assert.equal(queue.accepted[324].userId, claims[324].userId);

  const attempted = [];
  const completed = [];
  const requestsPerInvocation = [];
  for (const [index, message] of queue.accepted.entries()) {
    attempted.push(message.userId);
    requestsPerInvocation.push(1);
    if (index !== 9) completed.push(message.userId);
  }
  assert.equal(attempted.length, 325);
  assert.equal(Math.max(...requestsPerInvocation), 1);
  assert.equal(completed.includes(claims[10].userId), true);
  assert.equal(completed.includes(claims[324].userId), true);
  assert.notDeepEqual(attempted.slice(0, 50), attempted.slice(50, 100));
});

test("a rejected second send retains both attempted chunks and releases only the final chunk", async () => {
  const { enqueueDueRefreshes, RefreshProducerError } = await loadProducer();
  const claimed = makeClaims(300);
  const repository = new ClaimRepository(claimed);
  const queue = new RecordingQueue({ failAt: 2 });

  await assert.rejects(
    enqueueDueRefreshes({
      repository,
      queue,
      targetAt: TARGET_AT,
      source: "cron",
      clock: () => TARGET_AT,
    }),
    (error) => {
      assert.equal(error instanceof RefreshProducerError, true);
      assert.deepEqual(error.summary, {
        claimed: 300,
        enqueued: 100,
        released: 100,
        category: "queue_send",
      });
      return true;
    },
  );

  assert.deepEqual(queue.batchSizes, [100, 100]);
  assert.deepEqual(repository.releasedUserIds, claimed.slice(200).map((row) => row.userId));
  assert.equal(repository.stillClaimedCount, 200);
});

test("a lost response never retries an ambiguously accepted chunk", async () => {
  const { enqueueDueRefreshes, RefreshProducerError } = await loadProducer();
  const claimed = makeClaims(300);
  const repository = new ClaimRepository(claimed);
  const queue = new RecordingQueue({ failAt: 2, acceptBeforeFailure: true });

  await assert.rejects(
    enqueueDueRefreshes({
      repository,
      queue,
      targetAt: TARGET_AT,
      source: "manual",
      clock: () => TARGET_AT,
    }),
    (error) => error instanceof RefreshProducerError,
  );

  assert.deepEqual(queue.batchSizes, [100, 100]);
  assert.equal(queue.accepted.length, 200);
  assert.deepEqual(repository.releasedUserIds, claimed.slice(200).map((row) => row.userId));
  assert.equal(repository.stillClaimedCount, 200);

  const committedClaims = new Set();
  for (const message of [...queue.accepted, queue.accepted[100]]) {
    if (!committedClaims.has(message.claimId)) committedClaims.add(message.claimId);
  }
  assert.equal(committedClaims.size, 200);
});

test("producer summary uses database time and hashes only sorted claimed user IDs", async () => {
  const { enqueueDueRefreshes } = await loadProducer();
  const claims = makeClaims(3).reverse();
  const repository = new ClaimRepository(claims);
  const queue = new RecordingQueue();
  const summary = await enqueueDueRefreshes({
    repository,
    queue,
    targetAt: "2026-08-16T11:59:59.000Z",
    source: "manual",
    clock: () => TARGET_AT,
  });
  const expectedFingerprint = createHash("sha256")
    .update(claims.map(({ userId }) => userId).sort().join("\n"), "utf8")
    .digest("hex");

  assert.deepEqual(summary, {
    source: "manual",
    targetAt: TARGET_AT,
    claimed: 3,
    enqueued: 3,
    released: 0,
    cohortFingerprint: expectedFingerprint,
    oldestDueAgeMs: 3_000,
    durationMs: 0,
  });
});

test("an empty page has a null cohort and oldest-due age", async () => {
  const { enqueueDueRefreshes } = await loadProducer();
  const summary = await enqueueDueRefreshes({
    repository: new ClaimRepository([]),
    queue: new RecordingQueue(),
    targetAt: TARGET_AT,
    source: "cron",
    clock: () => TARGET_AT,
  });
  assert.equal(summary.claimed, 0);
  assert.equal(summary.cohortFingerprint, null);
  assert.equal(summary.oldestDueAgeMs, null);
});
