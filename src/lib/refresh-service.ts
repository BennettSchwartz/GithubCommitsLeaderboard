import type {
  ProducerSummary,
  QueueProducerLike,
  RefreshMessageV1,
} from "./refresh-contract";
import type { RefreshLogger } from "./refresh-log";
import {
  enqueueDueRefreshes,
  RefreshProducerError,
} from "./refresh-producer";
import type { RefreshRepository } from "./refresh-repository";

export type ProducerDependencies = {
  repository: RefreshRepository;
  queue: QueueProducerLike<RefreshMessageV1>;
  clock: () => string;
  logger: RefreshLogger;
};

function elapsedMilliseconds(startedAt: string, finishedAt: string) {
  const elapsed = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

export async function runRefreshProducer(
  input: { source: "cron" | "manual"; targetAt: string },
  deps: ProducerDependencies,
): Promise<ProducerSummary> {
  const startedAt = deps.clock();

  try {
    const summary = await enqueueDueRefreshes({
      repository: deps.repository,
      queue: deps.queue,
      targetAt: input.targetAt,
      source: input.source,
      clock: deps.clock,
    });
    deps.logger({
      eventId: crypto.randomUUID(),
      event: "refresh.producer.completed",
      observedAt: deps.clock(),
      source: input.source,
      targetAt: summary.targetAt,
      claimed: summary.claimed,
      enqueued: summary.enqueued,
      released: summary.released,
      cohortFingerprint: summary.cohortFingerprint,
      oldestDueAgeMs: summary.oldestDueAgeMs,
      durationMs: summary.durationMs,
    });
    return summary;
  } catch (error) {
    const observedAt = deps.clock();
    const producerFailure =
      error instanceof RefreshProducerError ? error.summary : null;
    deps.logger({
      eventId: crypto.randomUUID(),
      event: "refresh.producer.failed",
      observedAt,
      source: input.source,
      targetAt: input.targetAt,
      category: producerFailure ? "queue_send" : "database",
      claimed: producerFailure?.claimed ?? 0,
      enqueued: producerFailure?.enqueued ?? 0,
      released: producerFailure?.released ?? 0,
      durationMs: elapsedMilliseconds(startedAt, observedAt),
    });
    throw error;
  }
}
