import { z } from "zod";

export const REFRESH_INTERVAL_MS = 60 * 60 * 60 * 1000;
export const CLAIM_LEASE_MS = 8 * 60 * 60 * 1000;
export const CLAIM_PAGE_SIZE = 300;
export const QUEUE_SEND_BATCH_SIZE = 100;
export const PRIMARY_QUEUE_NAME = "githubcommits-refresh";
export const DLQ_QUEUE_NAME = "githubcommits-refresh-dlq";
export const GITHUB_REQUEST_LIMIT = 40;
export const PRIMARY_MAX_RETRIES = 5;
export const DLQ_MAX_RETRIES = 10;
export const DLQ_RETRY_DELAY_SECONDS = 7200;
export const TERMINAL_RETRY_MS = 24 * 60 * 60 * 1000;

const identifierFields = z
  .object({
    userId: z.string().uuid(),
    claimId: z.string().uuid(),
  })
  .strict();

export const refreshMessageV1Schema = identifierFields
  .extend({
    version: z.literal(1),
    targetAt: z.string().datetime({ offset: true }),
    enqueuedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const unsupportedRefreshMessageSchema = identifierFields
  .extend({
    version: z.number().int().refine((value) => value !== 1),
    targetAt: z.string().datetime({ offset: true }),
    enqueuedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RefreshMessageV1 = z.infer<typeof refreshMessageV1Schema>;

export type RefreshErrorCategory =
  | "auth"
  | "rate_limit"
  | "github_5xx"
  | "github_transient"
  | "github_terminal"
  | "database"
  | "unknown"
  | "invalid_message";

export type RetriableRefreshCategory =
  | "rate_limit"
  | "github_5xx"
  | "github_transient"
  | "unknown";

export type DeferredRefreshFailure =
  | { disposition: "retry"; category: "rate_limit" }
  | { disposition: "terminal"; category: "github_terminal" };

export type ParsedRefreshMessage =
  | { kind: "valid"; message: RefreshMessageV1 }
  | { kind: "unsupported"; messageIdFields: z.infer<typeof identifierFields> }
  | { kind: "unparseable" };

export type SafeMessageIds = {
  userId: string;
  claimId: string;
};

export function parseRefreshMessage(body: unknown): ParsedRefreshMessage {
  const parsed = refreshMessageV1Schema.safeParse(body);
  if (parsed.success) {
    return { kind: "valid", message: parsed.data };
  }

  const unsupported = unsupportedRefreshMessageSchema.safeParse(body);
  if (unsupported.success) {
    return {
      kind: "unsupported",
      messageIdFields: {
        userId: unsupported.data.userId,
        claimId: unsupported.data.claimId,
      },
    };
  }

  return { kind: "unparseable" };
}

export type RetryPolicy = {
  baseSeconds: number;
  capSeconds: number;
};

export function resolveRetryPolicy(env: {
  REFRESH_PRIMARY_QUEUE_NAME?: string;
  REFRESH_RETRY_BASE_SECONDS?: string;
  REFRESH_RETRY_CAP_SECONDS?: string;
}): RetryPolicy {
  const hasOverride =
    env.REFRESH_RETRY_BASE_SECONDS !== undefined || env.REFRESH_RETRY_CAP_SECONDS !== undefined;

  if (!hasOverride) {
    return { baseSeconds: 300, capSeconds: 3600 };
  }

  if (
    env.REFRESH_PRIMARY_QUEUE_NAME !== "githubcommits-refresh-canary-20260816" ||
    env.REFRESH_RETRY_BASE_SECONDS !== "2" ||
    env.REFRESH_RETRY_CAP_SECONDS !== "4"
  ) {
    throw new Error("invalid refresh retry override");
  }

  return { baseSeconds: 2, capSeconds: 4 };
}

export function computePrimaryRetryDelay(attempts: number, policy: RetryPolicy) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(policy.baseSeconds) ||
    !Number.isSafeInteger(policy.capSeconds) ||
    policy.baseSeconds < 1 ||
    policy.capSeconds < policy.baseSeconds
  ) {
    throw new RangeError("retry policy must use positive safe integers with baseSeconds at or below capSeconds");
  }

  const exponent = Math.min(attempts - 1, 1023);
  return Math.min(policy.baseSeconds * 2 ** exponent, policy.capSeconds);
}

export function projectWorstCaseQueueOperations(messageCount: number) {
  if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
    throw new RangeError("messageCount must be a nonnegative safe integer");
  }

  // One primary write; six primary deliveries plus one transfer read; primary
  // delete; one DLQ write; eleven DLQ deliveries plus one exhaustion read; and
  // the final DLQ delete. The envelope contract remains below one 64-KB chunk.
  const operationsPerMessage = 1 + 7 + 1 + 1 + 12 + 1;
  const projected = messageCount * operationsPerMessage;
  if (!Number.isSafeInteger(projected)) {
    throw new RangeError("projected queue operations exceed the safe integer range");
  }
  return projected;
}

export type QueueProducerLike<T> = {
  sendBatch(messages: readonly { body: T }[]): Promise<unknown>;
};

export type QueueMessageLike = {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type QueueBatchLike<T = unknown> = {
  queue: string;
  messages: readonly (QueueMessageLike & { body: T })[];
};

export type ProducerSummary = {
  source: "cron" | "manual";
  targetAt: string;
  claimed: number;
  enqueued: number;
  released: number;
  cohortFingerprint: string | null;
  oldestDueAgeMs: number | null;
  durationMs: number;
};

export type ConsumerSummary = {
  received: number;
  refreshed: number;
  terminal: number;
  retried: number;
  staleClaim: number;
  githubRequestsUsed: number;
  durationMs: number;
};

export type DlqSummary = {
  received: number;
  recorded: number;
  staleClaim: number;
  retried: number;
  durationMs: number;
};
