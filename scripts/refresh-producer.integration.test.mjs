import assert from "node:assert/strict";
import test from "node:test";

import { enqueueDueRefreshes } from "../src/lib/refresh-producer.ts";
import { createRefreshRepository } from "../src/lib/refresh-repository.ts";
import { openIsolatedPostgres } from "./test-support/isolated-postgres.mjs";

class RecordingQueue {
  constructor() {
    this.messages = [];
    this.batchSizes = [];
  }

  async sendBatch(entries) {
    this.batchSizes.push(entries.length);
    this.messages.push(...entries.map(({ body }) => body));
  }
}

test("concurrent producers claim disjoint bounded pages without a forecast lease and drain remaining due users", async () => {
  const isolated = await openIsolatedPostgres({ required: true });
  const client = await isolated.connect();
  try {
    await client.query(`
      INSERT INTO users (
        id, github_id, login, login_lc, avatar_url, profile_url, github_created_at
      )
      SELECT
        ('10000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        value,
        'producer_' || value,
        'producer_' || value,
        'https://example.test/avatar/' || value,
        'https://example.test/user/' || value,
        '2020-01-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 625) AS value
    `);
    await client.query(`
      INSERT INTO tokens (user_id, access_token_encrypted)
      SELECT id, 'dummy-ciphertext' FROM users
    `);
    await client.query(`
      INSERT INTO scores (user_id, next_refresh_at)
      SELECT id, '2026-01-01T00:00:00Z'::timestamptz FROM users
    `);
    const targetAt = new Date().toISOString();

    const repositoryA = createRefreshRepository({ DATABASE_URL: isolated.connectionString });
    const repositoryB = createRefreshRepository({ DATABASE_URL: isolated.connectionString });
    const queueA = new RecordingQueue();
    const queueB = new RecordingQueue();
    const base = { targetAt, source: "cron", clock: () => targetAt };

    const [left, right] = await Promise.all([
      enqueueDueRefreshes({ ...base, repository: repositoryA, queue: queueA }),
      enqueueDueRefreshes({ ...base, repository: repositoryB, queue: queueB }),
    ]);
    const messages = [...queueA.messages, ...queueB.messages];
    const userIds = messages.map(({ userId }) => userId);
    const claimIds = messages.map(({ claimId }) => claimId);

    assert.equal(left.claimed, 300);
    assert.equal(right.claimed, 300);
    assert.equal(messages.length, 600);
    assert.equal(new Set(userIds).size, 600);
    assert.equal(new Set(claimIds).size, 600);
    assert.equal([...queueA.batchSizes, ...queueB.batchSizes].every((size) => size <= 100), true);

    const remainder = await enqueueDueRefreshes({ ...base, repository: repositoryA, queue: queueA });
    assert.equal(remainder.claimed, 25);
    const drained = await enqueueDueRefreshes({ ...base, repository: repositoryB, queue: queueB });
    assert.equal(drained.claimed, 0);
    const allMessages = [...queueA.messages, ...queueB.messages];
    assert.equal(allMessages.length, 625);
    assert.equal(new Set(allMessages.map(({ userId }) => userId)).size, 625);
    assert.equal(new Set(allMessages.map(({ claimId }) => claimId)).size, 625);

    for (const invalidLimit of [0, -1, 301, 1.5]) {
      await assert.rejects(repositoryA.claimDueUsers(targetAt, targetAt, invalidLimit), RangeError);
    }
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});
