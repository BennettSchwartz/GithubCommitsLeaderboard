import { randomUUID } from "node:crypto";

import { z } from "zod";

const safeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const duration = z.number().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const category = z.enum([
  "auth",
  "rate_limit",
  "github_5xx",
  "github_transient",
  "github_terminal",
  "database",
  "unknown",
  "invalid_message",
]);

const base = z.object({
  eventId: z.string().uuid(),
  observedAt: timestamp,
});

const refreshLogEventSchema = z.discriminatedUnion("event", [
  base.extend({
    event: z.literal("refresh.producer.completed"),
    source: z.enum(["cron", "manual"]),
    targetAt: timestamp,
    claimed: safeInteger,
    enqueued: safeInteger,
    released: safeInteger,
    cohortFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    oldestDueAgeMs: duration.nullable(),
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.producer.failed"),
    source: z.enum(["cron", "manual"]),
    targetAt: timestamp,
    category: z.union([category, z.literal("queue_send")]),
    claimed: safeInteger,
    enqueued: safeInteger,
    released: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.consumer.completed"),
    received: safeInteger,
    refreshed: safeInteger,
    terminal: safeInteger,
    staleClaim: safeInteger,
    retried: safeInteger,
    githubRequestsUsed: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.consumer.failed"),
    category,
    received: safeInteger,
    refreshed: safeInteger,
    terminal: safeInteger,
    staleClaim: safeInteger,
    retried: safeInteger,
    githubRequestsUsed: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.dlq.completed"),
    received: safeInteger,
    recorded: safeInteger,
    staleClaim: safeInteger,
    retried: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.user.failed"),
    userId: z.string().uuid(),
    claimId: z.string().uuid(),
    queueMessageId: z.string().min(1),
    category,
    attempt: positiveSafeInteger,
    retryScheduled: z.boolean(),
    githubRequestsUsed: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.scheduler.defect"),
    userId: z.string().uuid(),
    claimId: z.string().uuid(),
    queueMessageId: z.string().min(1),
    category,
    defectCode: z.enum(["request_budget_exhausted", "platform_subrequest_limit"]),
    count: z.literal(1),
    githubRequestsUsed: safeInteger,
    durationMs: duration,
  }).strict(),
  base.extend({
    event: z.literal("refresh.message.invalid"),
    queueMessageId: z.string().min(1),
  }).strict(),
]);

export type RefreshLogEvent = z.infer<typeof refreshLogEventSchema>;
export type RefreshLogger = (event: RefreshLogEvent) => void;
export type RefreshLogSink = (serializedEvent: string) => void;

type WithoutEventId<T> = T extends unknown ? Omit<T, "eventId"> : never;
export type RefreshLogEventInput = WithoutEventId<RefreshLogEvent>;

export function parseRefreshLogEvent(value: unknown): RefreshLogEvent {
  return refreshLogEventSchema.parse(value);
}

export function createRefreshLogEvent(
  input: RefreshLogEventInput,
  eventId: string = randomUUID(),
): RefreshLogEvent {
  return parseRefreshLogEvent({ ...input, eventId });
}

export function emitRefreshLogEvent(
  logger: RefreshLogger,
  event: RefreshLogEvent,
): RefreshLogEvent {
  const parsed = parseRefreshLogEvent(event);
  logger(parsed);
  return parsed;
}

export function logRefreshEvent(
  logger: RefreshLogger,
  input: RefreshLogEventInput,
  eventId?: string,
): RefreshLogEvent {
  return emitRefreshLogEvent(logger, createRefreshLogEvent(input, eventId));
}

export function createRefreshLogger(
  sink: RefreshLogSink = (serializedEvent) => console.log(serializedEvent),
): RefreshLogger {
  return (event) => {
    const parsed = parseRefreshLogEvent(event);
    sink(JSON.stringify(parsed));
  };
}

export const refreshLogger = createRefreshLogger();
