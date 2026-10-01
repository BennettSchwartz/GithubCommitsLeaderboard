import {
  GITHUB_REQUEST_LIMIT,
  TERMINAL_RETRY_MS,
  computePrimaryRetryDelay,
  parseRefreshMessage,
  type ConsumerSummary,
  type QueueMessageLike,
  type RefreshErrorCategory,
  type RetriableRefreshCategory,
  type RetryPolicy,
} from "./refresh-contract";
import {
  GitHubRequestBudget,
  GitHubRequestError,
  computeAllTimeCommits,
  type GitHubErrorCode,
} from "./github-refresh";
import { logRefreshEvent, type RefreshLogger } from "./refresh-log";
import type { CasResult, RefreshRepository, RefreshSnapshot } from "./refresh-repository";

export type ConsumeRefreshMessageOptions = {
  message: QueueMessageLike;
  repository: RefreshRepository;
  decryptToken: (encrypted: string) => Promise<string>;
  fetchImpl: typeof fetch;
  githubEndpoint?: string;
  retryPolicy: RetryPolicy;
  clock: () => string;
  logger: RefreshLogger;
};

type FailureClassification = {
  category: Exclude<RefreshErrorCategory, "database" | "invalid_message">;
  transition: "auth" | "retry" | "terminal";
  retryAfterSeconds: number | null;
  defectCode: "request_budget_exhausted" | "platform_subrequest_limit" | null;
};

function elapsedMs(startedAt: number) {
  return Math.max(0, performance.now() - startedAt);
}

function emptySummary(startedAt: number): ConsumerSummary {
  return {
    received: 1,
    refreshed: 0,
    terminal: 0,
    retried: 0,
    staleClaim: 0,
    githubRequestsUsed: 0,
    durationMs: elapsedMs(startedAt),
  };
}

function withSummary(
  startedAt: number,
  budget: GitHubRequestBudget | null,
  changes: Partial<ConsumerSummary>,
): ConsumerSummary {
  return {
    ...emptySummary(startedAt),
    githubRequestsUsed: budget?.used ?? 0,
    ...changes,
    durationMs: elapsedMs(startedAt),
  };
}

function safeLog(
  logger: RefreshLogger,
  input: Parameters<typeof logRefreshEvent>[1],
) {
  try {
    logRefreshEvent(logger, input);
  } catch {
    // Database state and Queue action remain authoritative when log transport fails.
  }
}

function classifyFailure(error: unknown): FailureClassification {
  if (!(error instanceof GitHubRequestError)) {
    return {
      category: "unknown",
      transition: "retry",
      retryAfterSeconds: null,
      defectCode: null,
    };
  }

  const classifications: Record<GitHubErrorCode, FailureClassification> = {
    AUTH_INVALID: {
      category: "auth",
      transition: "auth",
      retryAfterSeconds: null,
      defectCode: null,
    },
    RATE_LIMITED: {
      category: "rate_limit",
      transition: "retry",
      retryAfterSeconds: error.retryAfterSeconds,
      defectCode: null,
    },
    UPSTREAM: {
      category: "github_5xx",
      transition: "retry",
      retryAfterSeconds: null,
      defectCode: null,
    },
    NETWORK: {
      category: "github_transient",
      transition: "retry",
      retryAfterSeconds: null,
      defectCode: null,
    },
    PLATFORM_SUBREQUEST_LIMIT: {
      category: "github_transient",
      transition: "retry",
      retryAfterSeconds: null,
      defectCode: "platform_subrequest_limit",
    },
    REQUEST_BUDGET_EXHAUSTED: {
      category: "github_terminal",
      transition: "terminal",
      retryAfterSeconds: null,
      defectCode: "request_budget_exhausted",
    },
    FORBIDDEN: {
      category: "github_terminal",
      transition: "terminal",
      retryAfterSeconds: null,
      defectCode: null,
    },
    GRAPHQL: {
      category: "github_terminal",
      transition: "terminal",
      retryAfterSeconds: null,
      defectCode: null,
    },
    GRAPHQL_RESOURCE_LIMIT: {
      category: "github_terminal",
      transition: "terminal",
      retryAfterSeconds: null,
      defectCode: null,
    },
    INVALID_RESPONSE: {
      category: "github_terminal",
      transition: "terminal",
      retryAfterSeconds: null,
      defectCode: null,
    },
  };
  return classifications[error.code];
}

function addMilliseconds(timestamp: string, milliseconds: number) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid repository attempt timestamp");
  return new Date(parsed + milliseconds).toISOString();
}

function logUserFailure({
  logger,
  message,
  snapshot,
  category,
  retryScheduled,
  githubRequestsUsed,
  durationMs,
}: {
  logger: RefreshLogger;
  message: QueueMessageLike;
  snapshot: RefreshSnapshot;
  category: RefreshErrorCategory;
  retryScheduled: boolean;
  githubRequestsUsed: number;
  durationMs: number;
}) {
  safeLog(logger, {
    event: "refresh.user.failed",
    observedAt: snapshot.attemptedAt,
    userId: snapshot.userId,
    claimId: snapshot.claimId,
    queueMessageId: message.id,
    category,
    attempt: message.attempts,
    retryScheduled,
    githubRequestsUsed,
    durationMs,
  });
}

function logDefect({
  logger,
  message,
  snapshot,
  classification,
  githubRequestsUsed,
  durationMs,
}: {
  logger: RefreshLogger;
  message: QueueMessageLike;
  snapshot: RefreshSnapshot;
  classification: FailureClassification;
  githubRequestsUsed: number;
  durationMs: number;
}) {
  if (classification.defectCode === null) return;
  safeLog(logger, {
    event: "refresh.scheduler.defect",
    observedAt: snapshot.attemptedAt,
    userId: snapshot.userId,
    claimId: snapshot.claimId,
    queueMessageId: message.id,
    category: classification.category,
    defectCode: classification.defectCode,
    count: 1,
    githubRequestsUsed,
    durationMs,
  });
}

function acknowledgeStale(
  message: QueueMessageLike,
  startedAt: number,
  budget: GitHubRequestBudget | null,
) {
  message.ack();
  return withSummary(startedAt, budget, { staleClaim: 1 });
}

async function retryDatabaseFailure({
  message,
  snapshot,
  logger,
  budget,
  startedAt,
}: {
  message: QueueMessageLike;
  snapshot: RefreshSnapshot;
  logger: RefreshLogger;
  budget: GitHubRequestBudget | null;
  startedAt: number;
}) {
  message.retry();
  const durationMs = elapsedMs(startedAt);
  logUserFailure({
    logger,
    message,
    snapshot,
    category: "database",
    retryScheduled: true,
    githubRequestsUsed: budget?.used ?? 0,
    durationMs,
  });
  return withSummary(startedAt, budget, { retried: 1 });
}

export async function consumeRefreshMessage({
  message,
  repository,
  decryptToken,
  fetchImpl,
  githubEndpoint,
  retryPolicy,
  clock,
  logger,
}: ConsumeRefreshMessageOptions): Promise<ConsumerSummary> {
  const startedAt = performance.now();
  const parsed = parseRefreshMessage(message.body);

  if (parsed.kind === "unparseable") {
    const observedAt = clock();
    safeLog(logger, {
      event: "refresh.message.invalid",
      observedAt,
      queueMessageId: message.id,
    });
    message.ack();
    return emptySummary(startedAt);
  }

  if (parsed.kind === "unsupported") {
    const observedAt = clock();
    try {
      await repository.recordInvalidMessage(message.id, parsed.messageIdFields, observedAt);
    } catch {
      message.retry();
      return withSummary(startedAt, null, { retried: 1 });
    }
    safeLog(logger, {
      event: "refresh.message.invalid",
      observedAt,
      queueMessageId: message.id,
    });
    message.ack();
    return emptySummary(startedAt);
  }

  if (!Number.isSafeInteger(message.attempts) || message.attempts < 1) {
    throw new TypeError("Queue message attempts must be a positive safe integer");
  }

  const requestedAttemptedAt = clock();
  let attempt: RefreshSnapshot | null;
  try {
    attempt = await repository.beginAttempt(parsed.message, requestedAttemptedAt);
  } catch {
    message.retry();
    safeLog(logger, {
      event: "refresh.user.failed",
      observedAt: requestedAttemptedAt,
      userId: parsed.message.userId,
      claimId: parsed.message.claimId,
      queueMessageId: message.id,
      category: "database",
      attempt: message.attempts,
      retryScheduled: true,
      githubRequestsUsed: 0,
      durationMs: elapsedMs(startedAt),
    });
    return withSummary(startedAt, null, { retried: 1 });
  }

  if (attempt === null) {
    return acknowledgeStale(message, startedAt, null);
  }

  const budget = new GitHubRequestBudget(GITHUB_REQUEST_LIMIT);
  try {
    const token = await decryptToken(attempt.accessTokenEncrypted);
    const requestOptions = {
      fetchImpl,
      budget,
      ...(githubEndpoint === undefined ? {} : { endpoint: githubEndpoint }),
    };
    const targetAt = new Date(attempt.targetAt);
    // Recount the full history each time. GitHub dates a contribution by its
    // commit time, so commits that land after an earlier check (late pushes,
    // newly verified emails) would be missed by a since-last-check delta.
    // The yearly windows go out as one aliased GraphQL request either way.
    const result = await computeAllTimeCommits(
      token,
      attempt.githubCreatedAt,
      targetAt,
      requestOptions,
    );
    const allTimeCommits = result.total;

    let committed: CasResult;
    try {
      committed = await repository.completeSuccess(attempt, allTimeCommits);
    } catch {
      return retryDatabaseFailure({ message, snapshot: attempt, logger, budget, startedAt });
    }
    if (committed === "stale") {
      return acknowledgeStale(message, startedAt, budget);
    }
    message.ack();
    return withSummary(startedAt, budget, { refreshed: 1 });
  } catch (error) {
    const classification = classifyFailure(error);
    const exponentialDelaySeconds = computePrimaryRetryDelay(message.attempts, retryPolicy);
    let committed: CasResult;
    let retryScheduled = false;
    let queueAction: "ack" | "retry" = "ack";
    let retryDelaySeconds: number | undefined;

    try {
      if (classification.transition === "auth") {
        committed = await repository.recordAuthFailure(attempt);
      } else if (classification.transition === "terminal") {
        committed = await repository.scheduleDeferredFailure(
          attempt,
          { disposition: "terminal", category: "github_terminal" },
          addMilliseconds(attempt.attemptedAt, TERMINAL_RETRY_MS),
        );
      } else if (
        classification.category === "rate_limit" &&
        classification.retryAfterSeconds !== null &&
        classification.retryAfterSeconds > 3_600
      ) {
        committed = await repository.scheduleDeferredFailure(
          attempt,
          { disposition: "retry", category: "rate_limit" },
          addMilliseconds(attempt.attemptedAt, classification.retryAfterSeconds * 1_000),
        );
        retryScheduled = true;
      } else {
        committed = await repository.recordRetriableFailure(
          attempt,
          classification.category as RetriableRefreshCategory,
        );
        retryScheduled = true;
        queueAction = "retry";
        retryDelaySeconds = Math.max(
          exponentialDelaySeconds,
          classification.retryAfterSeconds ?? 0,
        );
      }
    } catch {
      return retryDatabaseFailure({ message, snapshot: attempt, logger, budget, startedAt });
    }

    if (committed === "stale") {
      return acknowledgeStale(message, startedAt, budget);
    }

    if (queueAction === "retry") {
      message.retry({ delaySeconds: retryDelaySeconds });
    } else {
      message.ack();
    }

    const durationMs = elapsedMs(startedAt);
    logUserFailure({
      logger,
      message,
      snapshot: attempt,
      category: classification.category,
      retryScheduled,
      githubRequestsUsed: budget.used,
      durationMs,
    });
    logDefect({
      logger,
      message,
      snapshot: attempt,
      classification,
      githubRequestsUsed: budget.used,
      durationMs,
    });

    return withSummary(startedAt, budget, {
      terminal: classification.transition === "auth" || classification.transition === "terminal" ? 1 : 0,
      retried: retryScheduled ? 1 : 0,
    });
  }
}
