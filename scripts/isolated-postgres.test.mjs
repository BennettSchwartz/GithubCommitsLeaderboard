import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIsolatedDatabaseUrls,
  openIsolatedPostgres,
} from "./test-support/isolated-postgres.mjs";

test("requires TEST_DATABASE_URL when requested", async () => {
  const previous = process.env.TEST_DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  try {
    await assert.rejects(
      openIsolatedPostgres(),
      /TEST_DATABASE_URL is required for scheduler integration tests/,
    );
  } finally {
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
  }
});

test("isolated database comparison ignores credentials scheme aliases and query", () => {
  const testUrl = "postgres://test-user:test-pass@db.example.test/app%2Ddb?sslmode=disable";

  for (const productionUrl of [
    "postgresql://prod:secret@db.example.test:5432/app%2Ddb",
    "postgres://someone:else@db.example.test/app%2Ddb?sslmode=require",
  ]) {
    assert.throws(
      () => assertIsolatedDatabaseUrls(testUrl, productionUrl, "production"),
      /must not target the same database as production/,
    );
  }
});

test("isolated database comparison allows a distinct host port or database", () => {
  const testUrl = "postgresql://localhost:5432/scheduler_test";
  assert.doesNotThrow(() =>
    assertIsolatedDatabaseUrls(testUrl, undefined, "missing production"),
  );
  assert.doesNotThrow(() =>
    assertIsolatedDatabaseUrls(testUrl, "postgres://otherhost/scheduler_test", "host"),
  );
  assert.doesNotThrow(() =>
    assertIsolatedDatabaseUrls(testUrl, "postgres://localhost:5433/scheduler_test", "port"),
  );
  assert.doesNotThrow(() =>
    assertIsolatedDatabaseUrls(testUrl, "postgres://localhost/production", "database"),
  );
});

test("isolated database comparison rejects invalid or unsupported URLs", () => {
  assert.throws(
    () => assertIsolatedDatabaseUrls("http://localhost/test", undefined, "production"),
    /PostgreSQL URL/,
  );
  assert.throws(
    () => assertIsolatedDatabaseUrls("postgres://localhost", undefined, "production"),
    /database name/,
  );
});
