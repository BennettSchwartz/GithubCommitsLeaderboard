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

test("concurrent enqueueDueRefreshes calls claim disjoint users", async () => {
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
      FROM generate_series(1, 325) AS value
    `);
    await client.query(`
      INSERT INTO tokens (user_id, access_token_encrypted)
      SELECT id, 'dummy-ciphertext' FROM users
    `);
    await client.query(`
      INSERT INTO scores (user_id, next_refresh_at)
      SELECT id, '2026-01-01T00:00:00Z'::timestamptz FROM users
    `);
    const capacity = await client.query(`
      WITH observed AS (
        SELECT clock_timestamp() AS target_at
      )
      UPDATE refresh_capacity_control
      SET evaluated_at = observed.target_at - interval '1 minute',
          valid_until = observed.target_at - interval '1 minute' + interval '6 hours',
          forecast_sha256 = repeat('a', 64)
      FROM observed
      WHERE singleton = TRUE
      RETURNING to_char(observed.target_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS target_at
    `);
    const targetAt = capacity.rows[0].target_at;
    assert.equal(typeof targetAt, "string");

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

    assert.equal(left.claimed + right.claimed, 325);
    assert.equal(messages.length, 325);
    assert.equal(new Set(userIds).size, 325);
    assert.equal(new Set(claimIds).size, 325);
    assert.equal(userIds.some((userId) => userId.endsWith("000000000325")), true);
    assert.equal([...queueA.batchSizes, ...queueB.batchSizes].every((size) => size <= 100), true);
  } finally {
    await client.end();
    await isolated.cleanup();
  }
});
