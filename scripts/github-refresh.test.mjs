import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubRequestBudget,
  GitHubRequestError,
  buildYearlyContributionWindows,
  computeAllTimeCommits,
  computeIncrementalCommits,
  fetchCommitContributionTotal,
  requestGitHubGraphql,
} from "../src/lib/github-refresh.ts";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const call = {
      input: String(input),
      init,
      body: JSON.parse(String(init?.body ?? "null")),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function aliasedSuccessFetch(values) {
  return recordingFetch((_call, index) => {
    assert.equal(index, 0);
    return jsonResponse({
      data: {
        viewer: Object.fromEntries(
          values.map(([publicCommits, restrictedCommits], valueIndex) => [
            `year${valueIndex}`,
            {
              totalCommitContributions: publicCommits,
              restrictedContributionsCount: restrictedCommits,
            },
          ]),
        ),
      },
    });
  });
}

function resourceThenYearlyFetch(totals) {
  return recordingFetch((_call, index) => {
    if (index === 0) {
      return jsonResponse({
        errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED", message: "raw provider detail" }],
      });
    }
    const total = totals[index - 1];
    assert.notEqual(total, undefined);
    return jsonResponse({
      data: {
        viewer: {
          contributionsCollection: {
            totalCommitContributions: total,
            restrictedContributionsCount: 0,
          },
        },
      },
    });
  });
}

function countingFetch(response = jsonResponse({ data: { viewer: { login: "octocat" } } })) {
  return recordingFetch(() => response);
}

test("preserves public plus restricted score in one aliased request", async () => {
  const progress = [];
  const fetchImpl = aliasedSuccessFetch([
    [10, 2],
    [20, 3],
    [30, 4],
  ]);
  const result = await computeAllTimeCommits(
    "dummy",
    "2024-01-01T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl, onProgress: (event) => progress.push(event) },
  );
  assert.equal(result.total, 69);
  assert.equal(result.requestsUsed, 1);
  assert.deepEqual(progress, [
    { window: 1, total: 3, commitsSoFar: 12, yearLabel: "2024" },
    { window: 2, total: 3, commitsSoFar: 35, yearLabel: "2025" },
    { window: 3, total: 3, commitsSoFar: 69, yearLabel: "2026" },
  ]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].body.query, /year0: contributionsCollection/);
  assert.match(fetchImpl.calls[0].body.query, /year2: contributionsCollection/);
  assert.deepEqual(Object.keys(fetchImpl.calls[0].body.variables).sort(), [
    "from0",
    "from1",
    "from2",
    "to0",
    "to1",
    "to2",
  ]);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer dummy");
});

test("resource rejection falls directly back one request per year", async () => {
  const progress = [];
  const fetchImpl = resourceThenYearlyFetch([12, 13, 14]);
  const result = await computeAllTimeCommits(
    "dummy",
    "2024-01-01T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl, onProgress: (event) => progress.push(event) },
  );
  assert.equal(result.total, 39);
  assert.equal(result.requestsUsed, 4);
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(progress.map((event) => event.commitsSoFar), [12, 25, 39]);
});

test("oldest account fallback stays under budget", async () => {
  const budget = new GitHubRequestBudget(40);
  const result = await computeAllTimeCommits(
    "dummy",
    "2008-02-08T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl: resourceThenYearlyFetch(new Array(19).fill(1)), budget },
  );
  assert.equal(result.requestsUsed, 20);
  assert.equal(budget.used, 20);
});

test("an oldest-account aliased success accepts double-digit alias indexes", async () => {
  const fetchImpl = aliasedSuccessFetch(new Array(19).fill([1, 0]));
  const result = await computeAllTimeCommits(
    "dummy",
    "2008-02-08T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl },
  );
  assert.equal(result.total, 19);
  assert.equal(result.requestsUsed, 1);
});

test("the request helper refuses call 41 before fetch", async () => {
  const fetchImpl = countingFetch();
  const budget = new GitHubRequestBudget(40);
  budget.consume(40);
  await assert.rejects(
    requestGitHubGraphql("dummy-token", "query { viewer { login } }", {}, { fetchImpl, budget }),
    { code: "REQUEST_BUDGET_EXHAUSTED" },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("fallback preflight makes zero yearly calls when all windows cannot fit", async () => {
  const fetchImpl = resourceThenYearlyFetch([12, 13, 14]);
  const budget = new GitHubRequestBudget(2);
  await assert.rejects(
    computeAllTimeCommits(
      "dummy",
      "2024-01-01T00:00:00.000Z",
      new Date("2026-08-16T00:00:00.000Z"),
      { fetchImpl, budget },
    ),
    { code: "REQUEST_BUDGET_EXHAUSTED" },
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("builds contiguous inclusive yearly windows", () => {
  assert.deepEqual(
    buildYearlyContributionWindows(
      "2024-06-15T12:34:56.789Z",
      new Date("2026-02-03T04:05:06.007Z"),
    ),
    [
      { from: "2024-06-15T12:34:56.789Z", to: "2024-12-31T23:59:59.999Z" },
      { from: "2025-01-01T00:00:00.000Z", to: "2025-12-31T23:59:59.999Z" },
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-03T04:05:06.007Z" },
    ],
  );
});

test("incremental refresh starts one millisecond after the prior checkpoint", async () => {
  const fetchImpl = recordingFetch((call) => {
    assert.deepEqual(call.body.variables, {
      from: "2026-08-15T00:00:00.001Z",
      to: "2026-08-16T00:00:00.000Z",
    });
    return jsonResponse({
      data: {
        viewer: {
          contributionsCollection: {
            totalCommitContributions: 7,
            restrictedContributionsCount: 2,
          },
        },
      },
    });
  });
  assert.deepEqual(
    await computeIncrementalCommits(
      "dummy",
      "2026-08-15T00:00:00.000Z",
      new Date("2026-08-16T00:00:00.000Z"),
      { fetchImpl },
    ),
    { delta: 9, checkedAt: "2026-08-16T00:00:00.000Z", requestsUsed: 1 },
  );
});

test("incremental no-op consumes no request", async () => {
  const fetchImpl = countingFetch();
  const result = await computeIncrementalCommits(
    "dummy",
    "2026-08-16T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl },
  );
  assert.deepEqual(result, { delta: 0, checkedAt: "2026-08-16T00:00:00.000Z", requestsUsed: 0 });
  assert.equal(fetchImpl.calls.length, 0);
});

test("compatibility contribution wrapper sums both fields", async () => {
  const fetchImpl = recordingFetch(() =>
    jsonResponse({
      data: {
        viewer: {
          contributionsCollection: {
            totalCommitContributions: 6,
            restrictedContributionsCount: 5,
          },
        },
      },
    }),
  );
  assert.equal(
    await fetchCommitContributionTotal(
      "dummy",
      "2026-01-01T00:00:00.000Z",
      "2026-08-16T00:00:00.000Z",
      { fetchImpl },
    ),
    11,
  );
});

const classificationCases = [
  {
    name: "HTTP 401",
    response: () => jsonResponse({ raw: "do not leak" }, { status: 401 }),
    code: "AUTH_INVALID",
    status: 401,
  },
  {
    name: "GraphQL unauthorized",
    response: () => jsonResponse({ errors: [{ type: "UNAUTHORIZED", message: "secret detail" }] }),
    code: "AUTH_INVALID",
    status: 200,
  },
  {
    name: "HTTP rate limit",
    response: () =>
      jsonResponse(
        { raw: "do not leak" },
        { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "4102444800" } },
      ),
    code: "RATE_LIMITED",
    status: 403,
  },
  {
    name: "HTTP 429",
    response: () => jsonResponse({}, { status: 429, headers: { "Retry-After": "17" } }),
    code: "RATE_LIMITED",
    status: 429,
    retryAfterSeconds: 17,
  },
  {
    name: "GraphQL rate limit",
    response: () => jsonResponse({ errors: [{ type: "RATE_LIMITED", message: "secret detail" }] }),
    code: "RATE_LIMITED",
    status: 200,
  },
  {
    name: "resource-only GraphQL errors",
    response: () =>
      jsonResponse({
        errors: [
          { type: "MAX_NODE_LIMIT_EXCEEDED", message: "secret one" },
          { type: "MAX_COMPLEXITY", message: "secret two" },
        ],
      }),
    code: "GRAPHQL_RESOURCE_LIMIT",
    status: 200,
  },
  {
    name: "mixed GraphQL errors",
    response: () =>
      jsonResponse({
        errors: [
          { type: "MAX_COMPLEXITY", message: "secret one" },
          { type: "SOMETHING_ELSE", message: "secret two" },
        ],
      }),
    code: "GRAPHQL",
    status: 200,
  },
  {
    name: "forbidden without rate headers",
    response: () => jsonResponse({}, { status: 403 }),
    code: "FORBIDDEN",
    status: 403,
  },
  {
    name: "upstream 500",
    response: () => jsonResponse({ raw: "private upstream" }, { status: 500 }),
    code: "UPSTREAM",
    status: 500,
  },
  {
    name: "data plus errors",
    response: () =>
      jsonResponse({ data: { viewer: { login: "octocat" } }, errors: [{ type: "OTHER", message: "secret" }] }),
    code: "GRAPHQL",
    status: 200,
  },
  {
    name: "missing data",
    response: () => jsonResponse({}),
    code: "INVALID_RESPONSE",
    status: 200,
  },
];

for (const fixture of classificationCases) {
  test(`classifies ${fixture.name} without leaking provider content`, async () => {
    const fetchImpl = countingFetch(fixture.response());
    await assert.rejects(
      requestGitHubGraphql("dummy", "query { viewer { login } }", {}, { fetchImpl }),
      (error) => {
        assert.ok(error instanceof GitHubRequestError);
        assert.equal(error.code, fixture.code);
        assert.equal(error.status, fixture.status);
        if (fixture.retryAfterSeconds !== undefined) {
          assert.equal(error.retryAfterSeconds, fixture.retryAfterSeconds);
        }
        assert.doesNotMatch(error.message, /secret|private|raw|provider detail/i);
        return true;
      },
    );
  });
}

test("classifies rejected fetch as network without leaking its message", async () => {
  const fetchImpl = recordingFetch(() => Promise.reject(new Error("socket host secret")));
  await assert.rejects(
    requestGitHubGraphql("dummy", "query { viewer { login } }", {}, { fetchImpl }),
    (error) => {
      assert.equal(error.code, "NETWORK");
      assert.doesNotMatch(error.message, /socket|host|secret/);
      return true;
    },
  );
});

test("classifies the Workers subrequest exception separately", async () => {
  const fetchImpl = recordingFetch(() => Promise.reject(new Error("Too many subrequests.")));
  await assert.rejects(
    requestGitHubGraphql("dummy", "query { viewer { login } }", {}, { fetchImpl }),
    { code: "PLATFORM_SUBREQUEST_LIMIT" },
  );
});

test("rejects malformed JSON and malformed contribution data", async () => {
  const malformedJsonFetch = countingFetch(new Response("private malformed body", { status: 200 }));
  await assert.rejects(
    requestGitHubGraphql("dummy", "query { viewer { login } }", {}, { fetchImpl: malformedJsonFetch }),
    { code: "INVALID_RESPONSE" },
  );

  const malformedDataFetch = recordingFetch(() =>
    jsonResponse({ data: { viewer: { contributionsCollection: { totalCommitContributions: "7" } } } }),
  );
  await assert.rejects(
    fetchCommitContributionTotal(
      "dummy",
      "2026-01-01T00:00:00.000Z",
      "2026-08-16T00:00:00.000Z",
      { fetchImpl: malformedDataFetch },
    ),
    { code: "INVALID_RESPONSE" },
  );
});

test("reports only requests consumed by a call when sharing a budget", async () => {
  const budget = new GitHubRequestBudget(40);
  budget.consume(3);
  const result = await computeAllTimeCommits(
    "dummy",
    "2026-01-01T00:00:00.000Z",
    new Date("2026-08-16T00:00:00.000Z"),
    { fetchImpl: aliasedSuccessFetch([[4, 1]]), budget },
  );
  assert.equal(result.requestsUsed, 1);
  assert.equal(budget.used, 4);
});
