import {
  DLQ_QUEUE_NAME,
  PRIMARY_QUEUE_NAME,
  type ConsumerSummary,
  type DlqSummary,
  type QueueBatchLike,
  type RetryPolicy,
} from "./refresh-contract";
import { consumeRefreshMessage } from "./refresh-consumer";
import { consumeDeadLetterMessage } from "./refresh-dlq";
import type { RefreshLogger } from "./refresh-log";
import type { UserRefreshDependencies } from "./onboarding-refresh";
import type { RefreshRepository } from "./refresh-repository";
import {
  runRefreshProducer,
  type ProducerDependencies,
} from "./refresh-service";
import type { RuntimeEnv } from "./runtime-env";

export type PrimaryQueueDependencies = UserRefreshDependencies & {
  retryPolicy: RetryPolicy;
};

export type DeadLetterDependencies = {
  repository: RefreshRepository;
  clock: () => string;
  logger: RefreshLogger;
};

export type QueueRouteResult =
  | { queue: "primary"; summary: ConsumerSummary }
  | { queue: "dlq"; summary: DlqSummary };

export type WorkerExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

export type ScheduledControllerLike = {
  cron: string;
  scheduledTime: number;
};

export type RefreshWorkerHandlerLike = {
  fetch(
    request: Request,
    env: RuntimeEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<Response>;
  scheduled(
    controller: ScheduledControllerLike,
    env: RuntimeEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<void>;
  queue(
    batch: QueueBatchLike,
    env: RuntimeEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<void>;
};

function emptyConsumerSummary(): ConsumerSummary {
  return {
    received: 0,
    refreshed: 0,
    terminal: 0,
    retried: 0,
    staleClaim: 0,
    githubRequestsUsed: 0,
    durationMs: 0,
  };
}

function emptyDlqSummary(): DlqSummary {
  return {
    received: 0,
    recorded: 0,
    staleClaim: 0,
    retried: 0,
    durationMs: 0,
  };
}

function mergeConsumerSummary(
  aggregate: ConsumerSummary,
  next: ConsumerSummary,
) {
  aggregate.received += next.received;
  aggregate.refreshed += next.refreshed;
  aggregate.terminal += next.terminal;
  aggregate.retried += next.retried;
  aggregate.staleClaim += next.staleClaim;
  aggregate.githubRequestsUsed += next.githubRequestsUsed;
  aggregate.durationMs += next.durationMs;
}

function mergeDlqSummary(aggregate: DlqSummary, next: DlqSummary) {
  aggregate.received += next.received;
  aggregate.recorded += next.recorded;
  aggregate.staleClaim += next.staleClaim;
  aggregate.retried += next.retried;
  aggregate.durationMs += next.durationMs;
}

export async function runPrimaryQueueBatch(
  batch: QueueBatchLike,
  deps: PrimaryQueueDependencies,
): Promise<ConsumerSummary> {
  const summary = emptyConsumerSummary();
  try {
    for (const message of batch.messages) {
      mergeConsumerSummary(
        summary,
        await consumeRefreshMessage({
          message,
          repository: deps.repository,
          decryptToken: deps.decryptToken,
          fetchImpl: deps.fetchImpl,
          githubEndpoint: deps.githubEndpoint,
          retryPolicy: deps.retryPolicy,
          clock: deps.clock,
          logger: deps.logger,
        }),
      );
    }
    deps.logger({
      eventId: crypto.randomUUID(),
      event: "refresh.consumer.completed",
      observedAt: deps.clock(),
      ...summary,
    });
    return summary;
  } catch (error) {
    deps.logger({
      eventId: crypto.randomUUID(),
      event: "refresh.consumer.failed",
      observedAt: deps.clock(),
      category: "database",
      ...summary,
    });
    throw error;
  }
}

export async function runDeadLetterBatch(
  batch: QueueBatchLike,
  deps: DeadLetterDependencies,
): Promise<DlqSummary> {
  const summary = emptyDlqSummary();
  for (const message of batch.messages) {
    mergeDlqSummary(
      summary,
      await consumeDeadLetterMessage({
        message,
        repository: deps.repository,
        clock: deps.clock,
        logger: deps.logger,
      }),
    );
  }
  deps.logger({
    eventId: crypto.randomUUID(),
    event: "refresh.dlq.completed",
    observedAt: deps.clock(),
    ...summary,
  });
  return summary;
}

export async function runScheduledRefresh(
  env: RuntimeEnv,
  deps: ProducerDependencies,
) {
  // Delayed Cron deliveries must not reuse controller.scheduledTime. The
  // invocation clock is only skew telemetry; PostgreSQL owns the actual target.
  void env;
  return runRefreshProducer(
    { source: "cron", targetAt: deps.clock() },
    deps,
  );
}

export async function routeRefreshQueueBatch(
  batch: QueueBatchLike,
  env: RuntimeEnv,
  deps: {
    primary: PrimaryQueueDependencies;
    dlq: DeadLetterDependencies;
  },
): Promise<QueueRouteResult> {
  const primaryName = env.REFRESH_PRIMARY_QUEUE_NAME ?? PRIMARY_QUEUE_NAME;
  const dlqName = env.REFRESH_DLQ_NAME ?? DLQ_QUEUE_NAME;

  if (batch.queue === primaryName) {
    return {
      queue: "primary",
      summary: await runPrimaryQueueBatch(batch, deps.primary),
    };
  }
  if (batch.queue === dlqName) {
    return {
      queue: "dlq",
      summary: await runDeadLetterBatch(batch, deps.dlq),
    };
  }
  throw new Error(`Unknown refresh queue: ${batch.queue}`);
}
