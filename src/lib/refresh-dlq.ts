import {
  DLQ_RETRY_DELAY_SECONDS,
  parseRefreshMessage,
  type DlqSummary,
  type QueueMessageLike,
} from "./refresh-contract";
import { logRefreshEvent, type RefreshLogger } from "./refresh-log";
import type { RefreshRepository } from "./refresh-repository";

export type ConsumeDeadLetterMessageOptions = {
  message: QueueMessageLike;
  repository: RefreshRepository;
  clock: () => string;
  logger: RefreshLogger;
};

function elapsedMs(startedAt: number) {
  return Math.max(0, performance.now() - startedAt);
}

function summary(
  startedAt: number,
  changes: Partial<Omit<DlqSummary, "received" | "durationMs">> = {},
): DlqSummary {
  return {
    received: 1,
    recorded: 0,
    staleClaim: 0,
    retried: 0,
    ...changes,
    durationMs: elapsedMs(startedAt),
  };
}

function logInvalidMessage(
  logger: RefreshLogger,
  observedAt: string,
  queueMessageId: string,
) {
  try {
    logRefreshEvent(logger, {
      event: "refresh.message.invalid",
      observedAt,
      queueMessageId,
    });
  } catch {
    // The durable audit remains authoritative if application-log transport fails.
  }
}

function retryDeadLetter(message: QueueMessageLike, startedAt: number) {
  message.retry({ delaySeconds: DLQ_RETRY_DELAY_SECONDS });
  return summary(startedAt, { retried: 1 });
}

export async function consumeDeadLetterMessage({
  message,
  repository,
  clock,
  logger,
}: ConsumeDeadLetterMessageOptions): Promise<DlqSummary> {
  const startedAt = performance.now();
  const parsed = parseRefreshMessage(message.body);
  const requestedObservedAt = clock();

  if (parsed.kind === "unparseable") {
    logInvalidMessage(logger, requestedObservedAt, message.id);
    message.ack();
    return summary(startedAt);
  }

  if (parsed.kind === "unsupported") {
    try {
      await repository.recordInvalidMessage(
        message.id,
        parsed.messageIdFields,
        requestedObservedAt,
      );
    } catch {
      return retryDeadLetter(message, startedAt);
    }
    logInvalidMessage(logger, requestedObservedAt, message.id);
    message.ack();
    return summary(startedAt, { recorded: 1 });
  }

  try {
    const result = await repository.reconcileDeadLetter(
      message.id,
      parsed.message,
      requestedObservedAt,
    );
    message.ack();
    return result === "committed"
      ? summary(startedAt, { recorded: 1 })
      : summary(startedAt, { recorded: 1, staleClaim: 1 });
  } catch {
    return retryDeadLetter(message, startedAt);
  }
}
