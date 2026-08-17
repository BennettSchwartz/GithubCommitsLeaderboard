import { GITHUB_REQUEST_LIMIT } from "./refresh-contract";

const DEFAULT_GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const AUTH_ERROR_TYPES = new Set(["UNAUTHORIZED"]);
const RATE_LIMIT_ERROR_TYPES = new Set(["RATE_LIMITED", "RATE_LIMIT", "RATE_LIMITED_BY_IP"]);
const RESOURCE_LIMIT_ERROR_TYPES = new Set([
  "MAX_NODE_LIMIT_EXCEEDED",
  "RESOURCE_LIMITS_EXCEEDED",
  "MAX_COMPLEXITY",
]);

export type GitHubErrorCode =
  | "AUTH_INVALID"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "GRAPHQL_RESOURCE_LIMIT"
  | "GRAPHQL"
  | "UPSTREAM"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "REQUEST_BUDGET_EXHAUSTED"
  | "PLATFORM_SUBREQUEST_LIMIT";

export class GitHubRequestError extends Error {
  constructor(
    public readonly code: GitHubErrorCode,
    message: string,
    public readonly status: number | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

export class GitHubRequestBudget {
  private count = 0;

  constructor(public readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("GitHub request limit must be a nonnegative safe integer");
    }
  }

  get used() {
    return this.count;
  }

  get remaining() {
    return this.limit - this.count;
  }

  canConsume(count = 1) {
    return Number.isSafeInteger(count) && count >= 0 && count <= this.remaining;
  }

  consume(count = 1) {
    if (!this.canConsume(count)) {
      throw new GitHubRequestError(
        "REQUEST_BUDGET_EXHAUSTED",
        "GitHub request budget exhausted",
      );
    }
    this.count += count;
  }
}

export type GitHubRequestOptions = {
  fetchImpl?: typeof fetch;
  budget?: GitHubRequestBudget;
  endpoint?: string;
  onProgress?: (event: GitHubContributionProgress) => void;
};

export type GitHubContributionProgress = {
  window: number;
  total: number;
  commitsSoFar: number;
  yearLabel: string;
};

export type GitHubTotalResult = {
  total: number;
  checkedAt: string;
  requestsUsed: number;
};

export type GitHubDeltaResult = {
  delta: number;
  checkedAt: string;
  requestsUsed: number;
};

export type ContributionWindow = {
  from: string;
  to: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(
  status: number | null = null,
  message = "GitHub returned an invalid response",
) {
  return new GitHubRequestError("INVALID_RESPONSE", message, status);
}

function parseRetryAfter(value: string | null) {
  if (value === null) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function parseRateLimitReset(value: string | null) {
  if (value === null) return null;
  const epochSeconds = Number(value);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) return null;
  return Math.max(0, Math.ceil(epochSeconds - Date.now() / 1000));
}

function classifyHttpFailure(response: Response): GitHubRequestError {
  const status = response.status;

  if (status === 401) {
    return new GitHubRequestError("AUTH_INVALID", "GitHub authentication failed", status);
  }

  if (status === 429) {
    return new GitHubRequestError(
      "RATE_LIMITED",
      "GitHub rate limit exceeded",
      status,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }

  if (status === 403) {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    const resetAfter = parseRateLimitReset(response.headers.get("X-RateLimit-Reset"));
    if (remaining === "0" || retryAfter !== null) {
      return new GitHubRequestError(
        "RATE_LIMITED",
        "GitHub rate limit exceeded",
        status,
        retryAfter ?? resetAfter,
      );
    }
    return new GitHubRequestError("FORBIDDEN", "GitHub request was forbidden", status);
  }

  if (status >= 500) {
    return new GitHubRequestError("UPSTREAM", "GitHub upstream request failed", status);
  }

  return new GitHubRequestError("INVALID_RESPONSE", "GitHub returned an unexpected HTTP status", status);
}

function graphQlErrorType(value: unknown) {
  if (!isObject(value)) return null;
  if (typeof value.type === "string") return value.type;
  if (isObject(value.extensions) && typeof value.extensions.code === "string") {
    return value.extensions.code;
  }
  return null;
}

function classifyGraphQlErrors(errors: unknown[], status: number) {
  const types = errors.map(graphQlErrorType);
  if (types.every((type) => type !== null && AUTH_ERROR_TYPES.has(type))) {
    return new GitHubRequestError("AUTH_INVALID", "GitHub authentication failed", status);
  }
  if (types.every((type) => type !== null && RATE_LIMIT_ERROR_TYPES.has(type))) {
    return new GitHubRequestError("RATE_LIMITED", "GitHub rate limit exceeded", status);
  }
  if (types.every((type) => type !== null && RESOURCE_LIMIT_ERROR_TYPES.has(type))) {
    return new GitHubRequestError(
      "GRAPHQL_RESOURCE_LIMIT",
      "GitHub GraphQL resource limit exceeded",
      status,
    );
  }
  return new GitHubRequestError("GRAPHQL", "GitHub GraphQL request failed", status);
}

function isPlatformSubrequestError(error: unknown) {
  return error instanceof Error && /too many subrequests/i.test(error.message);
}

export async function requestGitHubGraphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const budget = options.budget ?? new GitHubRequestBudget(GITHUB_REQUEST_LIMIT);
  const endpoint = options.endpoint ?? DEFAULT_GITHUB_GRAPHQL_ENDPOINT;

  budget.consume();

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "github-commits-leaderboard",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
  } catch (error) {
    if (isPlatformSubrequestError(error)) {
      throw new GitHubRequestError(
        "PLATFORM_SUBREQUEST_LIMIT",
        "GitHub request exceeded the platform subrequest limit",
      );
    }
    throw new GitHubRequestError("NETWORK", "GitHub network request failed");
  }

  if (!response.ok) {
    throw classifyHttpFailure(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponse(response.status);
  }

  if (!isObject(payload)) {
    throw invalidResponse(response.status);
  }

  if (payload.errors !== undefined) {
    if (!Array.isArray(payload.errors) || payload.errors.length === 0) {
      throw invalidResponse(response.status);
    }
    throw classifyGraphQlErrors(payload.errors, response.status);
  }

  if (!isObject(payload.data)) {
    throw invalidResponse(response.status);
  }

  return payload.data as T;
}

function parseTimestamp(value: string, label: string) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new GitHubRequestError("INVALID_RESPONSE", `Invalid ${label} timestamp`);
  }
  return timestamp;
}

function assertTargetAt(targetAt: Date) {
  if (!(targetAt instanceof Date) || !Number.isFinite(targetAt.getTime())) {
    throw new GitHubRequestError("INVALID_RESPONSE", "Invalid target timestamp");
  }
}

function endOfYearUtc(year: number) {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

export function buildYearlyContributionWindows(
  githubCreatedAt: string,
  targetAt: Date,
): ContributionWindow[] {
  const start = parseTimestamp(githubCreatedAt, "GitHub account creation");
  assertTargetAt(targetAt);
  const end = new Date(targetAt);

  if (start >= end) return [];

  const windows: ContributionWindow[] = [];
  let cursor = start;

  while (cursor < end) {
    const yearEnd = endOfYearUtc(cursor.getUTCFullYear());
    const windowEnd = yearEnd < end ? yearEnd : end;
    windows.push({ from: cursor.toISOString(), to: windowEnd.toISOString() });
    cursor = new Date(windowEnd.getTime() + 1);
  }

  return windows;
}

function parseContributionCollection(value: unknown) {
  if (!isObject(value)) throw invalidResponse();

  const publicCommits = value.totalCommitContributions;
  const restrictedCommits = value.restrictedContributionsCount;
  if (
    !Number.isSafeInteger(publicCommits) ||
    !Number.isSafeInteger(restrictedCommits) ||
    (publicCommits as number) < 0 ||
    (restrictedCommits as number) < 0
  ) {
    throw invalidResponse();
  }

  const total = (publicCommits as number) + (restrictedCommits as number);
  if (!Number.isSafeInteger(total)) throw invalidResponse();
  return total;
}

function parseDirectContributionData(data: unknown) {
  if (!isObject(data) || !isObject(data.viewer)) throw invalidResponse();
  return parseContributionCollection(data.viewer.contributionsCollection);
}

const DIRECT_CONTRIBUTION_QUERY = `
  query ContributionWindow($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        restrictedContributionsCount
      }
    }
  }
`;

export async function fetchCommitContributionTotal(
  accessToken: string,
  from: string,
  to: string,
  options: GitHubRequestOptions = {},
): Promise<number> {
  const data = await requestGitHubGraphql<unknown>(
    accessToken,
    DIRECT_CONTRIBUTION_QUERY,
    { from, to },
    options,
  );
  return parseDirectContributionData(data);
}

function buildAliasedContributionQuery(windows: readonly ContributionWindow[]) {
  const definitions = windows.flatMap((_window, index) => [
    `$from${index}: DateTime!`,
    `$to${index}: DateTime!`,
  ]);
  const selections = windows.map(
    (_window, index) => `
      year${index}: contributionsCollection(from: $from${index}, to: $to${index}) {
        totalCommitContributions
        restrictedContributionsCount
      }`,
  );

  return `
    query ContributionWindows(${definitions.join(", ")}) {
      viewer {
        ${selections.join("\n")}
      }
    }
  `;
}

function buildAliasedVariables(windows: readonly ContributionWindow[]) {
  return Object.fromEntries(
    windows.flatMap((window, index) => [
      [`from${index}`, window.from],
      [`to${index}`, window.to],
    ]),
  );
}

function parseAliasedContributionData(data: unknown, windowCount: number) {
  if (!isObject(data) || !isObject(data.viewer)) throw invalidResponse();
  const viewer = data.viewer;

  const expectedKeys = Array.from({ length: windowCount }, (_value, index) => `year${index}`);
  const sortedExpectedKeys = [...expectedKeys].sort();
  const actualKeys = Object.keys(viewer).sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw invalidResponse();
  }

  return expectedKeys.map((key) => parseContributionCollection(viewer[key]));
}

function emitProgress(
  options: GitHubRequestOptions,
  window: ContributionWindow,
  index: number,
  total: number,
  commitsSoFar: number,
) {
  options.onProgress?.({
    window: index + 1,
    total,
    commitsSoFar,
    yearLabel: window.from.slice(0, 4),
  });
}

export async function computeAllTimeCommits(
  accessToken: string,
  githubCreatedAt: string,
  targetAt: Date,
  options: GitHubRequestOptions = {},
): Promise<GitHubTotalResult> {
  assertTargetAt(targetAt);
  const checkedAt = targetAt.toISOString();
  const windows = buildYearlyContributionWindows(githubCreatedAt, targetAt);
  const budget = options.budget ?? new GitHubRequestBudget(GITHUB_REQUEST_LIMIT);
  const usedBefore = budget.used;
  const requestOptions = { ...options, budget };

  if (windows.length === 0) {
    return { total: 0, checkedAt, requestsUsed: 0 };
  }

  try {
    const data = await requestGitHubGraphql<unknown>(
      accessToken,
      buildAliasedContributionQuery(windows),
      buildAliasedVariables(windows),
      requestOptions,
    );
    const totals = parseAliasedContributionData(data, windows.length);
    let total = 0;
    totals.forEach((value, index) => {
      total += value;
      if (!Number.isSafeInteger(total)) throw invalidResponse();
      emitProgress(options, windows[index], index, windows.length, total);
    });
    return { total, checkedAt, requestsUsed: budget.used - usedBefore };
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.code !== "GRAPHQL_RESOURCE_LIMIT") {
      throw error;
    }
  }

  if (!budget.canConsume(windows.length)) {
    throw new GitHubRequestError(
      "REQUEST_BUDGET_EXHAUSTED",
      "GitHub request budget exhausted",
    );
  }

  let total = 0;
  for (const [index, window] of windows.entries()) {
    total += await fetchCommitContributionTotal(
      accessToken,
      window.from,
      window.to,
      requestOptions,
    );
    if (!Number.isSafeInteger(total)) throw invalidResponse();
    emitProgress(options, window, index, windows.length, total);
  }

  return { total, checkedAt, requestsUsed: budget.used - usedBefore };
}

export async function computeIncrementalCommits(
  accessToken: string,
  priorCheckpoint: string,
  targetAt: Date,
  options: GitHubRequestOptions = {},
): Promise<GitHubDeltaResult> {
  assertTargetAt(targetAt);
  const prior = parseTimestamp(priorCheckpoint, "prior checkpoint");
  const from = new Date(prior.getTime() + 1);
  const checkedAt = targetAt.toISOString();
  const budget = options.budget ?? new GitHubRequestBudget(GITHUB_REQUEST_LIMIT);
  const usedBefore = budget.used;

  if (from >= targetAt) {
    return { delta: 0, checkedAt, requestsUsed: 0 };
  }

  const delta = await fetchCommitContributionTotal(
    accessToken,
    from.toISOString(),
    checkedAt,
    { ...options, budget },
  );
  return { delta, checkedAt, requestsUsed: budget.used - usedBefore };
}
