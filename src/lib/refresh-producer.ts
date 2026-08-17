import { createHash } from "node:crypto";

import {
  CLAIM_PAGE_SIZE,
  QUEUE_SEND_BATCH_SIZE,
  type ProducerSummary,
  type QueueProducerLike,
  type RefreshMessageV1,
} from "./refresh-contract";
import type { RefreshRepository } from "./refresh-repository";

export type EnqueueDueRefreshOptions = {
  repository: RefreshRepository;
  queue: QueueProducerLike<RefreshMessageV1>;
  targetAt: string;
  source: "cron" | "manual";
  clock: () => string;
};

export type RefreshProducerFailureSummary = {
  claimed: number;
  enqueued: number;
  released: number;
  category: "queue_send";
};

export class RefreshProducerError extends Error {
  constructor(
    public readonly summary: RefreshProducerFailureSummary,
    options?: ErrorOptions,
  ) {
    super("refresh producer enqueue failed", options);
    this.name = "RefreshProducerError";
  }
}

function cohortFingerprint(userIds: readonly string[]) {
  if (userIds.length === 0) return null;
  return createHash("sha256")
    .update([...userIds].sort().join("\n"), "utf8")
    .digest("hex");
}

function elapsedMs(startedAt: string, completedAt: string) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function oldestDueAgeMs(targetAt: string, dueTimes: readonly string[]) {
  if (dueTimes.length === 0) return null;
  const target = Date.parse(targetAt);
  const oldest = Math.min(...dueTimes.map((dueAt) => Date.parse(dueAt)));
  if (!Number.isFinite(target) || !Number.isFinite(oldest)) return null;
  return Math.max(0, target - oldest);
}

export async function enqueueDueRefreshes({
  repository,
  queue,
  targetAt,
  source,
  clock,
}: EnqueueDueRefreshOptions): Promise<ProducerSummary> {
  const requestedEnqueuedAt = clock();
  const page = await repository.claimDueUsers(targetAt, requestedEnqueuedAt, CLAIM_PAGE_SIZE);
  const { claims } = page;
  let enqueued = 0;
  let attemptedThrough = 0;

  try {
    for (let index = 0; index < claims.length; index += QUEUE_SEND_BATCH_SIZE) {
      const chunk = claims.slice(index, index + QUEUE_SEND_BATCH_SIZE);
      attemptedThrough = index + chunk.length;
      await queue.sendBatch(chunk.map((claim) => ({ body: claim.message })));
      enqueued += chunk.length;
    }
  } catch (error) {
    const neverAttempted = claims.slice(attemptedThrough);
    const released = await repository.releaseClaims(
      neverAttempted.map((claim) => claim.message),
    );
    throw new RefreshProducerError(
      {
        claimed: claims.length,
        enqueued,
        released,
        category: "queue_send",
      },
      { cause: error },
    );
  }

  return {
    source,
    targetAt: page.targetAt,
    claimed: claims.length,
    enqueued,
    released: 0,
    cohortFingerprint: cohortFingerprint(claims.map((claim) => claim.userId)),
    oldestDueAgeMs: oldestDueAgeMs(page.targetAt, claims.map((claim) => claim.dueAt)),
    durationMs: elapsedMs(requestedEnqueuedAt, clock()),
  };
}
