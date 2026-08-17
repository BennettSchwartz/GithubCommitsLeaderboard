import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";

import {
  CLAIM_LEASE_MS,
  CLAIM_PAGE_SIZE,
  type DeferredRefreshFailure,
  type RefreshMessageV1,
  type RetriableRefreshCategory,
  type SafeMessageIds,
} from "./refresh-contract";
import { withRefreshDb, withTransaction } from "./postgres";
import type { RuntimeEnv } from "./runtime-env";

export type CasResult = "committed" | "stale";
export type OnboardingCasResult = "committed" | "stale_winner" | "stale_token" | "stale_reconnect";
export type RefreshAttemptDisposition = "auth" | "retry" | "terminal" | "dlq";

export class RefreshCapacityLeaseError extends Error {
  readonly code = "REFRESH_CAPACITY_LEASE_EXPIRED";

  constructor() {
    super("refresh capacity lease is missing or expired");
    this.name = "RefreshCapacityLeaseError";
  }
}

export type RefreshMutationTestHooks = {
  afterLock?: (event: {
    operation:
      | "oauth_replacement"
      | "begin_attempt"
      | "success"
      | "auth_failure"
      | "terminal_failure"
      | "onboarding_success"
      | "invalid_message"
      | "dead_letter";
    relation: "users" | "tokens" | "scores";
    userId: string;
  }) => Promise<void>;
};

export type RefreshRepositoryOptions = { testHooks?: RefreshMutationTestHooks };

export type CommittedRefreshResult = {
  userId: string;
  allTimeCommits: number;
  checkedAt: string;
  rank: number;
  totalUsers: number;
  percentile: number;
};

export type ClaimedRefresh = {
  userId: string;
  claimId: string;
  dueAt: string;
  message: RefreshMessageV1;
};

export type ClaimPage = {
  targetAt: string;
  enqueuedAt: string;
  claims: ClaimedRefresh[];
};

export type RefreshSnapshot = {
  userId: string;
  claimId: string;
  targetAt: string;
  attemptedAt: string;
  startingCheckpoint: string | null;
  tokenUpdatedAt: string;
  accessTokenEncrypted: string;
  githubCreatedAt: string;
  allTimeCommits: number;
  failCount: number;
};

export type OnboardingSnapshot = {
  userId: string;
  targetAt: string;
  startingCheckpoint: string | null;
  tokenUpdatedAt: string;
  accessTokenEncrypted: string;
  githubCreatedAt: string;
  allTimeCommits: number;
};

export type BeginOnboardingResult =
  | { kind: "ready"; snapshot: OnboardingSnapshot }
  | { kind: "missing" }
  | { kind: "reconnect" };

export interface RefreshRepository {
  claimDueUsers(requestedTargetAt: string, requestedEnqueuedAt: string, limit?: number): Promise<ClaimPage>;
  releaseClaims(messages: readonly RefreshMessageV1[]): Promise<number>;
  beginAttempt(message: RefreshMessageV1, requestedAttemptedAt: string): Promise<RefreshSnapshot | null>;
  beginOnboardingAttempt(userId: string): Promise<BeginOnboardingResult>;
  reconcileLegacyCutover(observedAt: string): Promise<{
    dueBackfilled: number;
    obsoleteClaimsCleared: number;
    historyRepaired: number;
    legacyReconnectCandidatesRequeued: number;
  }>;
  completeSuccess(snapshot: RefreshSnapshot, allTimeCommits: number): Promise<CasResult>;
  completeOnboardingSuccess(snapshot: OnboardingSnapshot, allTimeCommits: number): Promise<OnboardingCasResult>;
  loadCommittedRefreshResult(userId: string): Promise<CommittedRefreshResult | null>;
  recordRetriableFailure(snapshot: RefreshSnapshot, category: RetriableRefreshCategory): Promise<CasResult>;
  recordAuthFailure(snapshot: RefreshSnapshot): Promise<CasResult>;
  scheduleDeferredFailure(snapshot: RefreshSnapshot, failure: DeferredRefreshFailure, nextRefreshAt: string): Promise<CasResult>;
  recordInvalidMessage(queueMessageId: string, ids: SafeMessageIds, requestedObservedAt: string): Promise<void>;
  reconcileDeadLetter(queueMessageId: string, message: RefreshMessageV1, requestedObservedAt: string): Promise<CasResult>;
}

type LockOperation = Parameters<NonNullable<RefreshMutationTestHooks["afterLock"]>>[0]["operation"];

type MutationRows = {
  user: { id: string; needs_reconnect: boolean; github_created_at: Date } | null;
  token: { access_token_encrypted: string; updated_at: Date } | null;
  score: {
    all_time_commits: number;
    last_checked_at: Date | null;
    refresh_claim_id: string | null;
    refresh_target_at: Date | null;
    refresh_claimed_until: Date | null;
    refresh_fail_count: number;
    last_refresh_error_code: string | null;
  } | null;
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRIABLE = new Set<RetriableRefreshCategory>([
  "rate_limit",
  "github_5xx",
  "github_transient",
  "unknown",
]);

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("database returned an invalid timestamp");
  return date.toISOString();
}

function parseIso(value: string, label: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new TypeError(`${label} must be a valid ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid ISO timestamp`);
  return date;
}

function validateTelemetryClock(value: string, databaseClock: Date, label: string) {
  const requested = parseIso(value, label);
  if (Math.abs(requested.getTime() - databaseClock.getTime()) > FIVE_MINUTES_MS) {
    throw new RangeError(`${label} differs from the database clock by more than five minutes`);
  }
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertQueueMessage(message: RefreshMessageV1) {
  if (message.version !== 1) throw new TypeError("refresh message version must be 1");
  assertUuid(message.userId, "userId");
  assertUuid(message.claimId, "claimId");
  parseIso(message.targetAt, "targetAt");
  parseIso(message.enqueuedAt, "enqueuedAt");
}

function assertCommitCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("allTimeCommits must be a nonnegative safe integer");
  }
}

function sameTimestamp(left: Date | null, right: string | null) {
  if (left === null || right === null) return left === null && right === null;
  return left.getTime() === new Date(right).getTime();
}

function eventKey(
  userId: string,
  claimId: string,
  logicalAt: string,
  category: string,
  disposition: RefreshAttemptDisposition,
) {
  return createHash("sha256")
    .update(`queue_v1\n${userId}\n${claimId}\n${logicalAt}\n${category}\n${disposition}\n`, "utf8")
    .digest("hex");
}

async function callHook(
  options: RefreshRepositoryOptions,
  operation: LockOperation,
  relation: "users" | "tokens" | "scores",
  userId: string,
) {
  await options.testHooks?.afterLock?.({ operation, relation, userId });
}

async function lockMutationRows(
  client: Client,
  userId: string,
  operation: LockOperation,
  options: RefreshRepositoryOptions,
): Promise<MutationRows> {
  const userResult = await client.query<MutationRows["user"] & object>(
    "SELECT id, needs_reconnect, github_created_at FROM users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  const user = userResult.rows[0] ?? null;
  if (user) await callHook(options, operation, "users", userId);

  const tokenResult = await client.query<MutationRows["token"] & object>(
    "SELECT access_token_encrypted, updated_at FROM tokens WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  const token = tokenResult.rows[0] ?? null;
  if (token) await callHook(options, operation, "tokens", userId);

  const scoreResult = await client.query<MutationRows["score"] & object>(
    `SELECT all_time_commits, last_checked_at, refresh_claim_id, refresh_target_at,
            refresh_claimed_until, refresh_fail_count, last_refresh_error_code
     FROM scores WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const score = scoreResult.rows[0] ?? null;
  if (score) await callHook(options, operation, "scores", userId);
  return { user, token, score };
}

function snapshotMatches(rows: MutationRows, snapshot: RefreshSnapshot) {
  return Boolean(
    rows.user &&
      !rows.user.needs_reconnect &&
      rows.token &&
      rows.score &&
      rows.score.refresh_claim_id === snapshot.claimId &&
      sameTimestamp(rows.score.refresh_target_at, snapshot.targetAt) &&
      sameTimestamp(rows.score.last_checked_at, snapshot.startingCheckpoint) &&
      rows.token.updated_at.getTime() === new Date(snapshot.tokenUpdatedAt).getTime(),
  );
}

async function appendAttemptEvent(
  client: Client,
  snapshot: RefreshSnapshot,
  category: string,
  disposition: RefreshAttemptDisposition,
) {
  const key = eventKey(
    snapshot.userId,
    snapshot.claimId,
    snapshot.attemptedAt,
    category,
    disposition,
  );
  await client.query(
    `INSERT INTO refresh_attempt_events (
       event_key, user_id, audit_user_id, claim_id, attempted_at, committed_at,
       category, disposition
     )
     VALUES ($1, $2, $2, $3, $4, clock_timestamp(), $5, $6)
     ON CONFLICT (event_key) DO NOTHING`,
    [key, snapshot.userId, snapshot.claimId, snapshot.attemptedAt, category, disposition],
  );
}

export function createRefreshRepository(
  env: RuntimeEnv,
  options: RefreshRepositoryOptions = {},
): RefreshRepository {
  const run = <T>(callback: (client: Client) => Promise<T>) =>
    withRefreshDb((client) => withTransaction(client, callback), { env });

  return {
    async claimDueUsers(requestedTargetAt, requestedEnqueuedAt, limit = CLAIM_PAGE_SIZE) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLAIM_PAGE_SIZE) {
        throw new RangeError(`limit must be between 1 and ${CLAIM_PAGE_SIZE}`);
      }
      return run(async (client) => {
        const capacity = await client.query<{
          generation: string;
          evaluated_at: Date | null;
          valid_until: Date | null;
          forecast_sha256: string | null;
          target_at: Date;
        }>(
          `SELECT generation::text, evaluated_at, valid_until, forecast_sha256,
                  clock_timestamp() AS target_at
           FROM refresh_capacity_control
           WHERE singleton = TRUE
           FOR SHARE`,
        );
        const lease = capacity.rows[0];
        if (!lease) throw new RefreshCapacityLeaseError();
        validateTelemetryClock(requestedTargetAt, lease.target_at, "requestedTargetAt");
        validateTelemetryClock(requestedEnqueuedAt, lease.target_at, "requestedEnqueuedAt");
        const generation = Number(lease.generation);
        if (
          !Number.isSafeInteger(generation) ||
          generation < 0 ||
          !lease.evaluated_at ||
          !lease.valid_until ||
          !lease.forecast_sha256 ||
          !/^[a-f0-9]{64}$/.test(lease.forecast_sha256) ||
          lease.target_at < lease.evaluated_at ||
          lease.target_at >= lease.valid_until
        ) {
          throw new RefreshCapacityLeaseError();
        }

        const due = await client.query<{ user_id: string; due_at: Date }>(
          `SELECT s.user_id,
                  COALESCE(s.next_refresh_at, s.last_checked_at + INTERVAL '60 hours', $1::timestamptz) AS due_at
           FROM scores s
           JOIN users u ON u.id = s.user_id
           JOIN tokens t ON t.user_id = s.user_id
           WHERE u.needs_reconnect = FALSE
             AND (
               s.next_refresh_at <= $1::timestamptz
               OR (
                 s.next_refresh_at IS NULL
                 AND (s.last_checked_at IS NULL OR s.last_checked_at <= $1::timestamptz - INTERVAL '60 hours')
               )
             )
             AND (s.refresh_claim_id IS NULL OR s.refresh_claimed_until <= $1::timestamptz)
           ORDER BY due_at ASC, s.user_id ASC
           LIMIT $2
           FOR UPDATE OF s SKIP LOCKED`,
          [lease.target_at, limit],
        );
        const claimIds = due.rows.map(() => randomUUID());
        if (due.rows.length > 0) {
          const updated = await client.query(
            `UPDATE scores s
             SET refresh_claim_id = claimed.claim_id,
                 refresh_target_at = $3::timestamptz,
                 refresh_claimed_until = $3::timestamptz + ($4::bigint * INTERVAL '1 millisecond')
             FROM unnest($1::uuid[], $2::uuid[]) AS claimed(user_id, claim_id)
             WHERE s.user_id = claimed.user_id
             RETURNING s.user_id`,
            [
              due.rows.map((row) => row.user_id),
              claimIds,
              lease.target_at,
              CLAIM_LEASE_MS,
            ],
          );
          if (updated.rowCount !== due.rows.length) throw new Error("failed to persist every refresh claim");
        }
        const targetAt = iso(lease.target_at);
        return {
          targetAt,
          enqueuedAt: targetAt,
          claims: due.rows.map((row, index) => {
            const claimId = claimIds[index]!;
            const message: RefreshMessageV1 = {
              version: 1,
              userId: row.user_id,
              claimId,
              targetAt,
              enqueuedAt: targetAt,
            };
            return { userId: row.user_id, claimId, dueAt: iso(row.due_at), message };
          }),
        };
      });
    },

    async releaseClaims(messages) {
      if (messages.length === 0) return 0;
      for (const message of messages) assertQueueMessage(message);
      return run(async (client) => {
        const capacity = await client.query<{ valid_until: Date | null }>(
          "SELECT valid_until FROM refresh_capacity_control WHERE singleton = TRUE FOR UPDATE",
        );
        if (capacity.rowCount !== 1) throw new Error("missing refresh_capacity_control singleton");
        const released = await client.query<{ due_at: Date }>(
          `UPDATE scores s
           SET refresh_claim_id = NULL,
               refresh_target_at = NULL,
               refresh_claimed_until = NULL
           FROM unnest($1::uuid[], $2::uuid[]) AS released(user_id, claim_id)
           WHERE s.user_id = released.user_id
             AND s.refresh_claim_id = released.claim_id
           RETURNING COALESCE(
             s.next_refresh_at,
             s.last_checked_at + INTERVAL '60 hours',
             clock_timestamp()
           ) AS due_at`,
          [messages.map((message) => message.userId), messages.map((message) => message.claimId)],
        );
        const validUntil = capacity.rows[0]?.valid_until;
        if (
          validUntil &&
          released.rows.some((row) => row.due_at < validUntil)
        ) {
          await client.query(
            `UPDATE refresh_capacity_control
             SET generation = generation + 1,
                 evaluated_at = NULL,
                 valid_until = NULL,
                 forecast_sha256 = NULL
             WHERE singleton = TRUE`,
          );
        }
        return released.rowCount ?? 0;
      });
    },

    async beginAttempt(message, requestedAttemptedAt) {
      assertQueueMessage(message);
      return run(async (client) => {
        const rows = await lockMutationRows(client, message.userId, "begin_attempt", options);
        const clock = await client.query<{ attempted_at: Date }>(
          "SELECT clock_timestamp() AS attempted_at",
        );
        const attemptedAt = clock.rows[0]!.attempted_at;
        validateTelemetryClock(requestedAttemptedAt, attemptedAt, "requestedAttemptedAt");
        if (!rows.user || rows.user.needs_reconnect || !rows.token || !rows.score) return null;
        if (
          rows.score.refresh_claim_id !== message.claimId ||
          !sameTimestamp(rows.score.refresh_target_at, message.targetAt)
        ) return null;
        if (
          rows.score.last_checked_at &&
          rows.score.last_checked_at.getTime() >= new Date(message.targetAt).getTime()
        ) {
          await client.query(
            `UPDATE scores
             SET refresh_claim_id = NULL,
                 refresh_target_at = NULL,
                 refresh_claimed_until = NULL,
                 next_refresh_at = GREATEST(
                   COALESCE(next_refresh_at, '-infinity'::timestamptz),
                   last_checked_at + INTERVAL '60 hours'
                 )
             WHERE user_id = $1 AND refresh_claim_id = $2`,
            [message.userId, message.claimId],
          );
          return null;
        }
        const renewed = await client.query<{ refresh_attempted_at: Date }>(
          `UPDATE scores
           SET refresh_attempted_at = $3,
               refresh_claimed_until = GREATEST(
                 COALESCE(refresh_claimed_until, '-infinity'::timestamptz),
                 $3::timestamptz + ($5::bigint * INTERVAL '1 millisecond')
               )
           WHERE user_id = $1
             AND refresh_claim_id = $2
             AND refresh_target_at = $4::timestamptz
           RETURNING refresh_attempted_at`,
          [
            message.userId,
            message.claimId,
            attemptedAt,
            message.targetAt,
            CLAIM_LEASE_MS,
          ],
        );
        if (renewed.rowCount !== 1) return null;
        return {
          userId: message.userId,
          claimId: message.claimId,
          targetAt: iso(rows.score.refresh_target_at!),
          attemptedAt: iso(renewed.rows[0]!.refresh_attempted_at),
          startingCheckpoint: rows.score.last_checked_at ? iso(rows.score.last_checked_at) : null,
          tokenUpdatedAt: iso(rows.token.updated_at),
          accessTokenEncrypted: rows.token.access_token_encrypted,
          githubCreatedAt: iso(rows.user.github_created_at),
          allTimeCommits: rows.score.all_time_commits,
          failCount: rows.score.refresh_fail_count,
        } satisfies RefreshSnapshot;
      });
    },

    async beginOnboardingAttempt(userId) {
      assertUuid(userId, "userId");
      return run(async (client) => {
        const result = await client.query<{
          id: string;
          needs_reconnect: boolean;
          github_created_at: Date;
          access_token_encrypted: string | null;
          token_updated_at: Date | null;
          all_time_commits: number | null;
          last_checked_at: Date | null;
          target_at: Date;
        }>(
          `SELECT u.id, u.needs_reconnect, u.github_created_at,
                  t.access_token_encrypted, t.updated_at AS token_updated_at,
                  s.all_time_commits, s.last_checked_at,
                  clock_timestamp() AS target_at
           FROM users u
           LEFT JOIN tokens t ON t.user_id = u.id
           LEFT JOIN scores s ON s.user_id = u.id
           WHERE u.id = $1`,
          [userId],
        );
        const row = result.rows[0];
        if (!row) return { kind: "missing" };
        if (row.needs_reconnect) return { kind: "reconnect" };
        if (
          row.access_token_encrypted === null ||
          row.token_updated_at === null ||
          row.all_time_commits === null
        ) return { kind: "missing" };
        return {
          kind: "ready",
          snapshot: {
            userId,
            targetAt: iso(row.target_at),
            startingCheckpoint: row.last_checked_at ? iso(row.last_checked_at) : null,
            tokenUpdatedAt: iso(row.token_updated_at),
            accessTokenEncrypted: row.access_token_encrypted,
            githubCreatedAt: iso(row.github_created_at),
            allTimeCommits: row.all_time_commits,
          },
        };
      });
    },

    async completeSuccess(snapshot, allTimeCommits) {
      assertCommitCount(allTimeCommits);
      return run(async (client) => {
        const rows = await lockMutationRows(client, snapshot.userId, "success", options);
        if (!rows.user || rows.user.needs_reconnect || !rows.token || !rows.score) return "stale";
        const ownsClaim =
          rows.score.refresh_claim_id === snapshot.claimId &&
          sameTimestamp(rows.score.refresh_target_at, snapshot.targetAt);
        const tokenMatches =
          rows.token.updated_at.getTime() === new Date(snapshot.tokenUpdatedAt).getTime();
        if (
          ownsClaim &&
          rows.score.last_checked_at &&
          rows.score.last_checked_at.getTime() >= new Date(snapshot.targetAt).getTime()
        ) {
          await client.query(
            `UPDATE scores SET refresh_claim_id = NULL, refresh_target_at = NULL,
                    refresh_claimed_until = NULL,
                    next_refresh_at = GREATEST(
                      COALESCE(next_refresh_at, '-infinity'::timestamptz),
                      last_checked_at + INTERVAL '60 hours'
                    )
             WHERE user_id = $1 AND refresh_claim_id = $2`,
            [snapshot.userId, snapshot.claimId],
          );
          return "stale";
        }
        if (!ownsClaim || !tokenMatches || !sameTimestamp(rows.score.last_checked_at, snapshot.startingCheckpoint)) {
          return "stale";
        }
        const updated = await client.query(
          `UPDATE scores
           SET all_time_commits = $2,
               last_checked_at = $3::timestamptz,
               last_updated_at = $3::timestamptz,
               next_refresh_at = $3::timestamptz + INTERVAL '60 hours',
               refresh_claim_id = NULL,
               refresh_target_at = NULL,
               refresh_claimed_until = NULL,
               refresh_attempted_at = $4::timestamptz,
               refresh_fail_count = 0,
               last_refresh_error_code = NULL
           WHERE user_id = $1
             AND refresh_claim_id = $5
             AND refresh_target_at = $3::timestamptz
             AND last_checked_at IS NOT DISTINCT FROM $6::timestamptz
           RETURNING user_id`,
          [snapshot.userId, allTimeCommits, snapshot.targetAt, snapshot.attemptedAt, snapshot.claimId, snapshot.startingCheckpoint],
        );
        if (updated.rowCount !== 1) return "stale";
        const bumped = await client.query(
          `UPDATE app_meta
           SET value = ((value)::integer + 1)::text, updated_at = clock_timestamp()
           WHERE key = 'leaderboard_version'`,
        );
        if (bumped.rowCount !== 1) throw new Error("missing leaderboard_version singleton");
        const history = await client.query(
          `INSERT INTO score_history (user_id, all_time_commits, recorded_at)
           VALUES ($1, $2, $3::timestamptz)`,
          [snapshot.userId, allTimeCommits, snapshot.targetAt],
        );
        if (history.rowCount !== 1) throw new Error("refresh success did not append score history");
        return "committed";
      });
    },

    async completeOnboardingSuccess(snapshot, allTimeCommits) {
      assertCommitCount(allTimeCommits);
      return run(async (client) => {
        const rows = await lockMutationRows(client, snapshot.userId, "onboarding_success", options);
        if (!rows.user || rows.user.needs_reconnect) return "stale_reconnect";
        if (!rows.token || !rows.score) return "stale_token";
        if (rows.token.updated_at.getTime() !== new Date(snapshot.tokenUpdatedAt).getTime()) {
          return "stale_token";
        }
        if (
          !sameTimestamp(rows.score.last_checked_at, snapshot.startingCheckpoint) ||
          rows.score.all_time_commits !== snapshot.allTimeCommits ||
          new Date(snapshot.targetAt).getTime() <= (rows.score.last_checked_at?.getTime() ?? -Infinity)
        ) {
          return "stale_winner";
        }
        const updated = await client.query(
          `UPDATE scores
           SET all_time_commits = $2,
               last_checked_at = $3::timestamptz,
               last_updated_at = $3::timestamptz,
               next_refresh_at = $3::timestamptz + INTERVAL '60 hours',
               refresh_claim_id = NULL,
               refresh_target_at = NULL,
               refresh_claimed_until = NULL,
               refresh_fail_count = 0,
               last_refresh_error_code = NULL
           WHERE user_id = $1
             AND last_checked_at IS NOT DISTINCT FROM $4::timestamptz
             AND all_time_commits = $5
           RETURNING user_id`,
          [snapshot.userId, allTimeCommits, snapshot.targetAt, snapshot.startingCheckpoint, snapshot.allTimeCommits],
        );
        if (updated.rowCount !== 1) return "stale_winner";
        const bumped = await client.query(
          `UPDATE app_meta SET value = ((value)::integer + 1)::text,
             updated_at = clock_timestamp() WHERE key = 'leaderboard_version'`,
        );
        if (bumped.rowCount !== 1) throw new Error("missing leaderboard_version singleton");
        const history = await client.query(
          "INSERT INTO score_history (user_id, all_time_commits, recorded_at) VALUES ($1, $2, $3::timestamptz)",
          [snapshot.userId, allTimeCommits, snapshot.targetAt],
        );
        if (history.rowCount !== 1) throw new Error("onboarding success did not append score history");
        return "committed";
      });
    },

    async loadCommittedRefreshResult(userId) {
      assertUuid(userId, "userId");
      return withRefreshDb(async (client) => {
        const result = await client.query<{
          user_id: string;
          all_time_commits: number;
          checked_at: Date | null;
          rank: string;
          total_users: string;
        }>(
          `WITH ranked AS (
             SELECT u.id AS user_id, s.all_time_commits, s.last_checked_at AS checked_at,
                    RANK() OVER (ORDER BY s.all_time_commits DESC, u.github_id ASC)::text AS rank,
                    COUNT(*) OVER ()::text AS total_users
             FROM users u JOIN scores s ON s.user_id = u.id
             WHERE u.needs_reconnect = FALSE
           )
           SELECT * FROM ranked WHERE user_id = $1`,
          [userId],
        );
        const row = result.rows[0];
        if (!row?.checked_at) return null;
        const rank = Number(row.rank);
        const totalUsers = Number(row.total_users);
        return {
          userId: row.user_id,
          allTimeCommits: row.all_time_commits,
          checkedAt: iso(row.checked_at),
          rank,
          totalUsers,
          percentile: Math.max(
            1,
            Math.ceil((1 - (rank - 1) / totalUsers) * 100),
          ),
        };
      }, { env });
    },

    async recordRetriableFailure(snapshot, category) {
      if (!RETRIABLE.has(category)) throw new TypeError("invalid retriable refresh category");
      return run(async (client) => {
        const rows = await lockMutationRows(client, snapshot.userId, "terminal_failure", options);
        if (!snapshotMatches(rows, snapshot)) return "stale";
        const updated = await client.query(
          `UPDATE scores
           SET refresh_attempted_at = $3::timestamptz,
               refresh_claimed_until = GREATEST(
                 COALESCE(refresh_claimed_until, '-infinity'::timestamptz),
                 $3::timestamptz + ($6::bigint * INTERVAL '1 millisecond')
               ),
               refresh_fail_count = refresh_fail_count + 1,
               last_refresh_error_code = $4
           WHERE user_id = $1 AND refresh_claim_id = $2
             AND refresh_target_at = $5::timestamptz
           RETURNING user_id`,
          [
            snapshot.userId,
            snapshot.claimId,
            snapshot.attemptedAt,
            category,
            snapshot.targetAt,
            CLAIM_LEASE_MS,
          ],
        );
        if (updated.rowCount !== 1) return "stale";
        await appendAttemptEvent(client, snapshot, category, "retry");
        return "committed";
      });
    },

    async recordAuthFailure(snapshot) {
      return run(async (client) => {
        const rows = await lockMutationRows(client, snapshot.userId, "auth_failure", options);
        if (!snapshotMatches(rows, snapshot)) return "stale";
        await client.query(
          "UPDATE users SET needs_reconnect = TRUE, updated_at = clock_timestamp() WHERE id = $1",
          [snapshot.userId],
        );
        const updated = await client.query(
          `UPDATE scores
           SET refresh_attempted_at = $3::timestamptz,
               last_refresh_error_code = 'auth',
               refresh_claim_id = NULL,
               refresh_target_at = NULL,
               refresh_claimed_until = NULL
           WHERE user_id = $1 AND refresh_claim_id = $2
             AND refresh_target_at = $4::timestamptz
           RETURNING user_id`,
          [snapshot.userId, snapshot.claimId, snapshot.attemptedAt, snapshot.targetAt],
        );
        if (updated.rowCount !== 1) return "stale";
        await appendAttemptEvent(client, snapshot, "auth", "auth");
        return "committed";
      });
    },

    async scheduleDeferredFailure(snapshot, failure, nextRefreshAt) {
      const due = parseIso(nextRefreshAt, "nextRefreshAt");
      if (
        !(
          (failure.disposition === "retry" && failure.category === "rate_limit") ||
          (failure.disposition === "terminal" && failure.category === "github_terminal")
        )
      ) throw new TypeError("invalid deferred refresh failure");
      return run(async (client) => {
        const capacity = await client.query<{ valid_until: Date | null }>(
          "SELECT valid_until FROM refresh_capacity_control WHERE singleton = TRUE FOR UPDATE",
        );
        if (capacity.rowCount !== 1) throw new Error("missing refresh_capacity_control singleton");
        const rows = await lockMutationRows(client, snapshot.userId, "terminal_failure", options);
        if (!snapshotMatches(rows, snapshot)) return "stale";
        const updated = await client.query(
          `UPDATE scores
           SET refresh_attempted_at = $3::timestamptz,
               refresh_fail_count = refresh_fail_count + 1,
               last_refresh_error_code = $4,
               next_refresh_at = $5::timestamptz,
               refresh_claim_id = NULL,
               refresh_target_at = NULL,
               refresh_claimed_until = NULL
           WHERE user_id = $1 AND refresh_claim_id = $2
             AND refresh_target_at = $6::timestamptz
           RETURNING user_id`,
          [snapshot.userId, snapshot.claimId, snapshot.attemptedAt, failure.category, due, snapshot.targetAt],
        );
        if (updated.rowCount !== 1) return "stale";
        const validUntil = capacity.rows[0]?.valid_until;
        if (validUntil && due < validUntil) {
          await client.query(
            `UPDATE refresh_capacity_control
             SET generation = generation + 1, evaluated_at = NULL,
                 valid_until = NULL, forecast_sha256 = NULL
             WHERE singleton = TRUE`,
          );
        }
        await appendAttemptEvent(client, snapshot, failure.category, failure.disposition);
        return "committed";
      });
    },

    async recordInvalidMessage(queueMessageId, ids, requestedObservedAt) {
      if (!queueMessageId) throw new TypeError("queueMessageId is required");
      assertUuid(ids.userId, "userId");
      assertUuid(ids.claimId, "claimId");
      await run(async (client) => {
        const owner = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE id = $1 FOR KEY SHARE",
          [ids.userId],
        );
        if (owner.rows[0]) await callHook(options, "invalid_message", "users", ids.userId);
        const clock = await client.query<{ observed_at: Date }>(
          "SELECT clock_timestamp() AS observed_at",
        );
        const observedAt = clock.rows[0]!.observed_at;
        validateTelemetryClock(requestedObservedAt, observedAt, "requestedObservedAt");
        await client.query(
          `INSERT INTO refresh_dead_letters (
             queue_message_id, user_id, claim_id, attempt_event_key, error_category,
             first_observed_at, last_observed_at, resolved_at
           )
           VALUES ($1, $2, $3, NULL, 'invalid_message', $4, $4, NULL)
           ON CONFLICT (queue_message_id)
           DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at,
                         resolved_at = COALESCE(
                           refresh_dead_letters.resolved_at,
                           EXCLUDED.resolved_at
                         ),
                         attempt_event_key = COALESCE(
                           refresh_dead_letters.attempt_event_key,
                           EXCLUDED.attempt_event_key
                         )`,
          [queueMessageId, owner.rows[0]?.id ?? null, ids.claimId, observedAt],
        );
      });
    },

    async reconcileDeadLetter(queueMessageId, message, requestedObservedAt) {
      if (!queueMessageId) throw new TypeError("queueMessageId is required");
      assertQueueMessage(message);
      return run(async (client) => {
        const rows = await lockMutationRows(client, message.userId, "dead_letter", options);
        const clock = await client.query<{ observed_at: Date }>(
          "SELECT clock_timestamp() AS observed_at",
        );
        const observedAt = clock.rows[0]!.observed_at;
        validateTelemetryClock(requestedObservedAt, observedAt, "requestedObservedAt");
        const category = rows.score?.last_refresh_error_code ?? "unknown";
        const matched = Boolean(
          rows.user &&
            !rows.user.needs_reconnect &&
            rows.token &&
            rows.score &&
            rows.score.refresh_claim_id === message.claimId &&
            sameTimestamp(rows.score.refresh_target_at, message.targetAt),
        );
        if (!matched) {
          await client.query(
            `INSERT INTO refresh_dead_letters (
               queue_message_id, user_id, claim_id, attempt_event_key, error_category,
               first_observed_at, last_observed_at, resolved_at
             ) VALUES ($1, $2, $3, NULL, $4, $5, $5, NULL)
             ON CONFLICT (queue_message_id)
             DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at,
                           resolved_at = COALESCE(
                             refresh_dead_letters.resolved_at,
                             EXCLUDED.resolved_at
                           ),
                           attempt_event_key = COALESCE(
                             refresh_dead_letters.attempt_event_key,
                             EXCLUDED.attempt_event_key
                           )`,
            [queueMessageId, rows.user?.id ?? null, message.claimId, category, observedAt],
          );
          return "stale";
        }
        const logicalAt = iso(observedAt);
        const key = eventKey(message.userId, message.claimId, logicalAt, category, "dlq");
        const result = await client.query<{ state_count: string; audit_count: string }>(
          `WITH state AS (
             UPDATE scores
             SET refresh_attempted_at = $5::timestamptz,
                 refresh_fail_count = refresh_fail_count + 1,
                 last_refresh_error_code = $4,
                 next_refresh_at = $5::timestamptz + INTERVAL '24 hours',
                 refresh_claim_id = NULL,
                 refresh_target_at = NULL,
                 refresh_claimed_until = NULL
             WHERE user_id = $2 AND refresh_claim_id = $3
               AND refresh_target_at = $6::timestamptz
             RETURNING user_id
           ), attempt AS (
             INSERT INTO refresh_attempt_events (
               event_key, user_id, audit_user_id, claim_id, attempted_at,
               committed_at, category, disposition
             )
             SELECT $7, state.user_id, state.user_id, $3, $5, clock_timestamp(), $4, 'dlq'
             FROM state
             ON CONFLICT (event_key) DO NOTHING
             RETURNING event_key
           ), event_ref AS (
             SELECT event_key FROM attempt
             UNION ALL
             SELECT $7 WHERE EXISTS (SELECT 1 FROM state)
               AND EXISTS (SELECT 1 FROM refresh_attempt_events WHERE event_key = $7)
             LIMIT 1
           ), audit AS (
             INSERT INTO refresh_dead_letters (
               queue_message_id, user_id, claim_id, attempt_event_key, error_category,
               first_observed_at, last_observed_at, resolved_at
             )
             SELECT $1, state.user_id, $3, event_ref.event_key, $4, $5, $5, $5
             FROM state CROSS JOIN event_ref
             ON CONFLICT (queue_message_id)
             DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at,
                           resolved_at = COALESCE(
                             refresh_dead_letters.resolved_at,
                             EXCLUDED.resolved_at
                           ),
                           attempt_event_key = COALESCE(
                             refresh_dead_letters.attempt_event_key,
                             EXCLUDED.attempt_event_key
                           )
             RETURNING queue_message_id
           )
           SELECT (SELECT count(*)::text FROM state) AS state_count,
                  (SELECT count(*)::text FROM audit) AS audit_count`,
          [queueMessageId, message.userId, message.claimId, category, observedAt, message.targetAt, key],
        );
        if (result.rows[0]?.state_count !== "1" || result.rows[0]?.audit_count !== "1") {
          throw new Error("dead-letter reconciliation did not atomically persist state and audit");
        }
        return "committed";
      });
    },

    async reconcileLegacyCutover(observedAt) {
      const requestedObserved = parseIso(observedAt, "observedAt");
      return run(async (client) => {
        const capacity = await client.query(
          "SELECT generation FROM refresh_capacity_control WHERE singleton = TRUE FOR UPDATE",
        );
        if (capacity.rowCount !== 1) throw new Error("missing refresh_capacity_control singleton");
        const clock = await client.query<{ observed_at: Date }>("SELECT clock_timestamp() AS observed_at");
        validateTelemetryClock(observedAt, clock.rows[0]!.observed_at, "observedAt");

        await client.query("SELECT id FROM users ORDER BY id FOR UPDATE");
        await client.query("SELECT user_id FROM tokens ORDER BY user_id FOR UPDATE");
        await client.query("SELECT user_id FROM scores ORDER BY user_id FOR UPDATE");

        const due = await client.query(
          `UPDATE scores s
           SET next_refresh_at = COALESCE(s.last_checked_at + INTERVAL '60 hours', $1::timestamptz)
           FROM users u
           WHERE u.id = s.user_id AND u.needs_reconnect = FALSE
             AND EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = u.id)
             AND s.next_refresh_at IS NULL
           RETURNING s.user_id`,
          [requestedObserved],
        );
        const obsolete = await client.query(
          `UPDATE scores s
           SET refresh_claim_id = NULL, refresh_target_at = NULL,
               refresh_claimed_until = NULL,
               next_refresh_at = CASE
                 WHEN u.needs_reconnect THEN s.next_refresh_at
                 ELSE GREATEST(
                   COALESCE(s.next_refresh_at, '-infinity'::timestamptz),
                   s.last_checked_at + INTERVAL '60 hours'
                 )
               END
           FROM users u
           WHERE u.id = s.user_id AND s.refresh_claim_id IS NOT NULL
             AND (u.needs_reconnect OR s.last_checked_at >= s.refresh_target_at)
           RETURNING s.user_id`,
        );

        const conflicts = await client.query(
          `SELECT 1 FROM scores s JOIN score_history h
             ON h.user_id = s.user_id AND h.recorded_at = s.last_checked_at
           WHERE s.last_checked_at IS NOT NULL
             AND h.all_time_commits <> s.all_time_commits
           LIMIT 1`,
        );
        if (conflicts.rowCount) throw new Error("conflicting score history checkpoint");

        const candidates = await client.query<{ user_id: string; token_updated_at: Date }>(
          `SELECT user_id, token_updated_at
           FROM refresh_legacy_reconnect_candidates
           WHERE resolved_at IS NULL
           ORDER BY user_id
           FOR UPDATE`,
        );
        let requeued = 0;
        for (const candidate of candidates.rows) {
          const current = await client.query<{ updated_at: Date; needs_reconnect: boolean }>(
            `SELECT t.updated_at, u.needs_reconnect
             FROM users u JOIN tokens t ON t.user_id = u.id
             WHERE u.id = $1`,
            [candidate.user_id],
          );
          if (
            current.rows[0] &&
            current.rows[0].updated_at.getTime() === candidate.token_updated_at.getTime()
          ) {
            await client.query(
              "UPDATE users SET needs_reconnect = FALSE, updated_at = clock_timestamp() WHERE id = $1",
              [candidate.user_id],
            );
            await client.query(
              `UPDATE scores SET refresh_claim_id = NULL, refresh_target_at = NULL,
                 refresh_claimed_until = NULL, last_refresh_error_code = NULL,
                 next_refresh_at = $2::timestamptz WHERE user_id = $1`,
              [candidate.user_id, requestedObserved],
            );
            requeued += 1;
          }
          await client.query(
            "UPDATE refresh_legacy_reconnect_candidates SET resolved_at = $2::timestamptz WHERE user_id = $1",
            [candidate.user_id, requestedObserved],
          );
        }

        if ((due.rowCount ?? 0) > 0 || (obsolete.rowCount ?? 0) > 0 || requeued > 0) {
          await client.query(
            `UPDATE refresh_capacity_control
             SET generation = generation + 1, evaluated_at = NULL,
                 valid_until = NULL, forecast_sha256 = NULL
             WHERE singleton = TRUE`,
          );
        }

        const missingHistory = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM scores s
           WHERE s.last_checked_at IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM score_history h
               WHERE h.user_id = s.user_id AND h.recorded_at = s.last_checked_at
             )`,
        );
        const repairCount = Number(missingHistory.rows[0]?.count ?? "0");
        if (repairCount > 0) {
          const bumped = await client.query(
            `UPDATE app_meta SET value = ((value)::integer + 1)::text,
               updated_at = clock_timestamp() WHERE key = 'leaderboard_version'`,
          );
          if (bumped.rowCount !== 1) throw new Error("missing leaderboard_version singleton");
        }
        const repaired = await client.query(
          `INSERT INTO score_history (user_id, all_time_commits, recorded_at)
           SELECT s.user_id, s.all_time_commits, s.last_checked_at
           FROM scores s
           WHERE s.last_checked_at IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM score_history h
               WHERE h.user_id = s.user_id AND h.recorded_at = s.last_checked_at
             )
           ORDER BY s.user_id`,
        );
        if ((repaired.rowCount ?? 0) !== repairCount) {
          throw new Error("legacy cutover history repair was not complete");
        }
        return {
          dueBackfilled: due.rowCount ?? 0,
          obsoleteClaimsCleared: obsolete.rowCount ?? 0,
          historyRepaired: repaired.rowCount ?? 0,
          legacyReconnectCandidatesRequeued: requeued,
        };
      });
    },
  };
}
