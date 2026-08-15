# Queue-Backed Refresh Scheduler Design

Date: 2026-08-15

Status: Concept approved; pending document review and implementation plan

Repository: `GithubCommitsLeaderboard`

## Summary

Replace the production all-users Cron refresh with an hourly producer and a
bounded Cloudflare Queue consumer. Each due user is claimed in PostgreSQL,
enqueued with a unique claim ID, and refreshed by a sequential queue consumer.
Transient failures retry with backoff, terminal authentication failures are
marked for reconnection, final writes use a claim-and-checkpoint compare-and-
swap, and repeatedly failing messages move to a dead-letter queue whose
consumer records durable database state.

This design fixes the observed stable-prefix starvation while preserving the
current score calculation and user-facing metric exactly as they are today.

## Confirmed Production Failure

Production is still running Worker version 32, deployed on 2026-05-04, with the
Cron expression `0 0 */3 * *`. The uncommitted hourly-wave changes in the local
working tree have not been deployed.

The deployed refresh selects every connected user in ascending GitHub ID order
and processes them serially in one invocation. The current production dataset
has 325 active users, but recent Cron runs wrote only 49 or 50 score-history
rows. The last two runs refreshed the same 50-user prefix. At audit time, 260
active users were more than three days stale and two had never completed a
refresh.

The Cron invocations used only 167-288 ms of CPU and about 28 seconds of wall
time. The failure is therefore not general Worker CPU or memory overload. It is
the combination of:

1. the 50-external-subrequest invocation ceiling observed in production;
2. one GitHub request per initialized user;
3. deterministic ascending-GitHub-ID selection on every run;
4. per-user errors being caught without advancing or logging the failed user;
5. no completion summary in the deployed Worker.

Once the invocation reaches the external-request ceiling, the remaining users
fail silently. The next Cron starts from the same prefix and repeats the cycle.

## Goals

- Select every healthy connected user for refresh after 60 hours so the hourly
  producer, queue latency, and claim recovery retain headroom below the
  three-day freshness ceiling.
- Keep every Worker invocation comfortably below Cloudflare's external
  subrequest limit.
- Prevent one persistent failure from blocking unrelated users.
- Prevent duplicate Cron or manual invocations from doing duplicate work.
- Make transient failures retriable and terminal failures visible.
- Make Cloudflare invocation outcomes and application logs reflect reality.
- Drain the existing stale backlog after deployment and verify that it stays
  drained.
- Provide a scheduler foundation that can later support public and seeded
  profiles without redesigning job delivery.

## Non-Goals

- Do not change the current contribution calculation.
- Do not change the current `totalCommitContributions +
  restrictedContributionsCount` behavior.
- Do not rename scores, alter leaderboard semantics, or migrate historical
  score values.
- Do not add public username lookup, seeded developer profiles, or new
  onboarding copy in this change.
- Do not change the current three-day freshness promise.
- Do not upgrade the Cloudflare billing plan as the fix.

The known contribution-versus-commit semantics issue is intentionally deferred
at the user's request.

## Chosen Architecture

### Cloudflare resources

Create two queues:

- `githubcommits-refresh`: primary refresh queue.
- `githubcommits-refresh-dlq`: dead-letter queue for messages that exhaust
  retries.

Bind the primary queue to the existing Worker as both producer and consumer.
Configure the consumer with:

- maximum batch size: 1 message;
- batch timeout: 5 seconds;
- maximum concurrency: 2 consumer invocations;
- maximum retries: 5;
- default retry delay: 5 minutes;
- dead-letter queue: `githubcommits-refresh-dlq`.

Each primary invocation receives one user and enforces a hard budget of 40
GitHub HTTP requests. A normal incremental invocation uses one request; even a
failed aliased query followed by one request per contribution year for the
oldest possible GitHub account remains below the observed 50-request ceiling.
Maximum concurrency of two limits GitHub pressure while still allowing the
current backlog to drain quickly.

Bind the DLQ to the same Worker as a second consumer with batch size 10,
concurrency 1, 10 retries, and a two-hour retry delay. The queue handler routes
by `batch.queue`. The DLQ consumer records a compact failure row, moves the user
to a future retry time when its claim still matches, clears that claim, and
acknowledges only after the database transaction commits.

Cloudflare Queue storage is transport, not permanent audit storage. The Free
plan retains messages for only 24 hours. Durable failure evidence therefore
lives in PostgreSQL; if PostgreSQL remains unavailable for the entire Queue
retention window, the claim expires and a later producer reclaims the user.
That outage case can lose the DLQ audit record, but cannot permanently strand
the user.

These values stay within Cloudflare's current documented limits of 100 messages
per consumer batch or `sendBatch`, 100 message retries, and a 24-hour Free-plan
retention window. The implementation plan must recheck those limits against
the installed Wrangler schema and the Cloudflare plugin immediately before
deployment. See [Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/),
and [Queues on Workers Free](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/).

The two-hour DLQ delay keeps ten retries spread across roughly 20 hours while
bounding Free-plan operations. Even if all 300 messages in a producer page
exhaust their five primary retries and ten DLQ retries, their Queue reads,
writes, and deletes remain below the documented 10,000-operation daily
allowance. This budget is rechecked using the production plan and live queue
volume before deployment. See [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).

### Scheduled producer

Change the Cron Trigger to run hourly. The producer does not refresh users
directly. It:

1. opens a database transaction;
2. selects due, unclaimed users in stable due-time order using row locks and
   `SKIP LOCKED`;
3. assigns each selected row a unique claim ID, the producer's target time, and
   an eight-hour claim lease;
4. commits and returns the claimed `(userId, claimId)` pairs;
5. sends versioned messages in sequential Queue API chunks of no more than 100
   messages, the documented `sendBatch` limit;
6. records each chunk as confirmed only after `sendBatch` resolves;
7. releases claims for the failed chunk and all later unsent chunks while
   retaining claims for earlier confirmed chunks.

The claim page is bounded to 300 users per hourly producer run. That covers the
current backlog in one producer pass while bounding database and queue work.
Three 100-message sends are required for a full page. A crash after the claim
transaction but before a send is recovered by the eight-hour lease; a known
send failure is recovered immediately by releasing only the unconfirmed
claims.

The scheduled handler directly awaits the producer. It logs a structured
summary on success. On a top-level failure, it logs a categorized error and
rethrows so Cloudflare records a failed Cron outcome.

### Queue message contract

Each message contains only identifiers and scheduling metadata:

```json
{
  "version": 1,
  "userId": "database-user-uuid",
  "claimId": "refresh-claim-uuid",
  "targetAt": "ISO-8601 timestamp",
  "enqueuedAt": "ISO-8601 timestamp"
}
```

Messages never contain OAuth tokens, encrypted tokens, GitHub profile data, or
raw error messages.

### Queue consumer

For each message, the consumer:

1. validates the version and required fields;
2. conditionally records the attempt and loads the user, current claim,
   starting `last_checked_at` checkpoint, and `tokens.updated_at` generation
   from PostgreSQL;
3. acknowledges a stale or mismatched claim without refreshing;
4. decrypts the user's token only inside the refresh operation;
5. fetches GitHub data through a client that refuses to exceed the invocation's
   40-request budget;
6. opens a database transaction, locks the score row, and rechecks both the
   claim ID and the starting checkpoint;
7. only if both still match, saves the score, score-history row,
   leaderboard-version bump, next refresh time, and scheduler state in that
   transaction;
8. clears the claim and failure metadata in that transaction on success;
9. acknowledges the message after commit.

The score update continues to set an absolute score rather than incrementing a
database value. The final compare-and-swap means two deliveries that both pass
the initial check cannot both commit: the loser sees a cleared claim or changed
checkpoint and discards its fetched result. The single-user onboarding path
must use the same checkpoint compare-and-swap. If onboarding wins, the queued
write becomes stale; its transaction also clears the old claim and scheduler
error state and sets `next_refresh_at` from its own checkpoint. If the queue
wins, onboarding reloads the committed result rather than overwriting it with
an older fetch.

OAuth token replacement atomically invalidates any active refresh claim. A
consumer that receives an authentication error rechecks both the claim ID and
the captured `tokens.updated_at` generation before setting `needs_reconnect`.
If the token was replaced, the old request is acknowledged as stale and cannot
mark the newly reconnected user as disconnected.

Malformed bodies are never retried indefinitely. An unsupported version with
safe identifiers is recorded as `invalid_message`; an unparseable body is
logged using only Cloudflare's message ID and is acknowledged without logging
or persisting its body.

For a retriable failure, the primary consumer updates the matching row's error
category and extends `refresh_claimed_until` before calling
`message.retry({ delaySeconds })`. Delays are the larger of GitHub's supported
rate-limit delay and `5 minutes * 2^(attempts - 1)`, capped at one hour. The
initial eight-hour lease exceeds the complete five-retry schedule, so the
hourly producer cannot reset retry progress by issuing a new claim. If the
database is unavailable and the lease cannot be extended, the original
eight-hour lease still covers the configured retry-delay schedule.

The lease is not a claim that Cloudflare will deliver within eight hours. If a
backlog delays first delivery beyond the lease, the consumer atomically renews
the still-matching expired claim before fetching, or acknowledges it as stale
if a producer already replaced it. Persistent `refresh_fail_count` survives a
new claim, so exceptional Queue latency cannot erase failure history.

## Database State

Add an additive migration to `scores` with:

- `refresh_claim_id UUID NULL`;
- `refresh_target_at TIMESTAMPTZ NULL`;
- `refresh_claimed_until TIMESTAMPTZ NULL`;
- `refresh_attempted_at TIMESTAMPTZ NULL`;
- `refresh_fail_count INTEGER NOT NULL DEFAULT 0`;
- `next_refresh_at TIMESTAMPTZ NULL`;
- `last_refresh_error_code TEXT NULL`.

Add a `refresh_dead_letters` table with the Cloudflare message ID as its primary
key, nullable user and claim IDs, a sanitized error category, first/last
observed timestamps, and resolution timestamp. The DLQ consumer uses an
idempotent upsert, so a crash after database commit but before acknowledgement
cannot duplicate audit state. The table never stores a queue body, token,
GitHub response, or raw exception.

Backfill `next_refresh_at` to `last_checked_at + 60 hours` for initialized
connected users and to the migration time for connected users that have never
completed a refresh. Add an index supporting due-user selection by
`next_refresh_at` and `user_id`.

A user is due when:

- `next_refresh_at` is at or before the producer's target time; or
- legacy fallback state has no `next_refresh_at` and either no checkpoint or a
  checkpoint at least 60 hours old.

Rows with an unexpired claim are excluded. Expired claims are eligible for a
new claim. Stable tie-breaking uses `user_id` after due time.

Claim IDs make late duplicate messages harmless. The lease also recovers from
the producer crashing after the database commit but before enqueueing. After a
successful refresh, `next_refresh_at` becomes `targetAt + 60 hours`; it is not
left null.

## GitHub Request Shape

Preserve the existing score formula. The initial all-time fetch first attempts
a GraphQL request containing aliased yearly `contributionsCollection` fields.
If GitHub rejects that query for resource complexity, it falls directly back
to one request per yearly field; it does not spend the budget on recursive
probe splits.

This is a behavior-preserving transport change: every yearly field still asks
for the same two values and the application sums them exactly as it does now.
The fetch client counts actual HTTP calls, not logical users, and refuses to
cross the consumer invocation's 40-request budget. It never substitutes a zero
year after an incomplete or failed fetch.

Incremental refresh remains one GraphQL request from the last checkpoint to the
message's fixed `targetAt` time.

## Failure Semantics

Whenever PostgreSQL is available, every matched non-authentication failure
updates `refresh_attempted_at`, increments `refresh_fail_count`, and stores only
its sanitized category before retrying or scheduling later work.

### Success

- Save the score and history row.
- Advance both `last_checked_at` and user-visible `last_updated_at` to
  `targetAt`, preserving the current display semantics on delayed retries.
- Clear the claim.
- Reset `refresh_fail_count` and `last_refresh_error_code`.
- Set `next_refresh_at` to `targetAt + 60 hours`.
- Acknowledge the queue message.

### Authentication failure

- Categorize as `auth` without storing the raw response body.
- Mark the user `needs_reconnect = TRUE`.
- Clear the claim.
- Record the terminal category.
- Acknowledge the message; do not retry it.

Only a typed GitHub `401`/`UNAUTHORIZED` result or equivalent verified token-
revocation signal is classified as `auth`, and only while the claim and token
generation still match. A generic `403` is never identified as reconnect-worthy
by matching error-message text.

### Rate limit or transient GitHub failure

- Categorize as `rate_limit`, `github_5xx`, or `github_transient`.
- Increment `refresh_fail_count` and record `refresh_attempted_at`.
- Classify from HTTP status, `Retry-After`, `X-RateLimit-*`, and GraphQL error
  types rather than raw text fragments.
- Honor supported retry/rate-reset headers up to one hour through Queue delay.
  For a longer server-mandated wait, persist that time in `next_refresh_at`,
  clear the claim, and acknowledge instead of retrying early.
- Otherwise use the bounded exponential delay defined above.
- Retry the individual message without retrying successful siblings.

### Other terminal GitHub failure

- Categorize a typed, non-authentication, non-rate-limit client error as
  `github_terminal`.
- Set `next_refresh_at` to 24 hours after the failed attempt and clear the claim.
- Acknowledge it without marking the user for reconnect.
- Alert when the same category affects multiple users, because that pattern is
  more likely a query or deployment defect than bad user data.

### Database or unknown failure

- Categorize as `database` or `unknown`.
- Leave the score checkpoint unchanged.
- Retry the individual message.
- After the configured primary attempts are exhausted, Cloudflare moves the
  message to the DLQ.
- The DLQ consumer transaction persists the dead-letter record, sets a future
  `next_refresh_at` 24 hours after reconciliation, and clears the active claim
  only when the claim still matches.
- If PostgreSQL is still unavailable, the DLQ consumer retries. If the outage
  outlasts Queue retention, the claim lease expires and normal due selection
  retries the user after PostgreSQL returns.

No raw access token, encrypted token, GraphQL response body, or potentially
sensitive exception payload is persisted or logged.

## Manual Refresh Endpoint

Change the authenticated `/api/jobs/refresh` endpoint to invoke the same claim
and enqueue producer used by Cron. It must not run a second direct all-users
refresh path. Its response returns an enqueue summary, not a claim that every
user has already refreshed.

Onboarding's single-user streaming refresh remains outside the queue because
the client is waiting for its progress. Its winning compare-and-swap transaction
updates the score/history and version, invalidates an older claim, clears
failure state, and sets `next_refresh_at` to its checkpoint plus 60 hours. A
losing onboarding write reloads the newer committed state.

## Observability

Emit structured JSON logs with event names and counts:

- `refresh.producer.completed`: claimed, enqueued, released, duration, and
  oldest due age;
- `refresh.consumer.completed`: received, refreshed, terminal, retried,
  stale-claim, GitHub requests used, and duration;
- `refresh.dlq.completed`: recorded, stale-claim, retried, and duration;
- `refresh.user.failed`: error category, attempt number, and whether the
  message will retry;
- `refresh.producer.failed` and `refresh.consumer.failed` for top-level
  failures.

Logs may contain database user UUIDs and queue message IDs for correlation, but
not usernames, OAuth tokens, encrypted tokens, or raw GitHub payloads.

Cloudflare invocation outcomes must remain failed when a top-level handler
fails. Per-message failures are represented through explicit retry/DLQ state
and batch summaries.

## Test Strategy

Implementation follows red-green-refactor. Required regression coverage:

1. Reproduce the deployed stable-prefix starvation with more than 50 users and
   a fake external-request ceiling.
2. Prove all claimed healthy users eventually refresh through queued batches.
3. Prove persistent failures cannot prevent a later healthy user from being
   claimed and processed.
4. Prove duplicate producer runs cannot claim an unexpired row twice.
5. Prove partial producer sends retain confirmed claims and release only the
   failed and unsent chunks.
6. Prove two deliveries with the same claim cannot both commit.
7. Prove a concurrent onboarding write and queued write cannot regress the
   checkpoint, overwrite the newer score, duplicate history, or leave an
   obsolete claim and next-refresh time.
8. Prove stale or duplicate claim IDs are acknowledged without score writes.
9. Prove the eight-hour lease covers the configured primary retry schedule and
   producer ticks do not reset message retry progress.
10. Prove auth errors mark reconnect and do not retry, while rate-limited 403s
    and 401s from a replaced token generation do not mark reconnect.
11. Prove transient/rate-limit errors retry only the failed message with the
   correct delay.
12. Prove exhausted messages reach the DLQ, duplicate DLQ deliveries upsert one
    audit row, and claim expiry recovers when database writes fail.
13. Prove malformed/unsupported messages follow the poison-message policy
    without logging their bodies.
14. Prove a multi-year initial refresh preserves the existing score calculation
    both in the one-query case and after resource-limit splitting.
15. Prove the oldest possible multi-year account completes within the budget
    after aliased-query fallback, and that an invocation refuses a forty-first
    GitHub HTTP request.
16. Prove the manual endpoint enqueues rather than directly processing every
    user.
17. Run type checking, the full repository test command, lint, and a production
    OpenNext Cloudflare build.

Pre-existing unrelated lint failures must be reported separately. They are not
silently attributed to this change or used to weaken scheduler-specific
verification.

## Deployment Order

1. Record a fresh pre-deployment database and Worker telemetry snapshot.
2. Apply the additive PostgreSQL migration.
3. Create the primary queue and DLQ with their retention and consumer settings.
4. Deploy the code first to a temporary canary Worker, isolated queues, and an
   isolated test database/schema; no production score row or credential is used.
5. In the canary, verify healthy delivery, retry, DLQ reconciliation, and a
   deliberately forced top-level failure in Cloudflare invocation telemetry.
6. Deploy the production Worker with queue bindings, both consumer
   configurations, hourly Cron, and the new code.
7. Verify the live deployment version, bindings, queue consumers, Cron, and
   observability settings through the Cloudflare plugin/API.
8. Invoke the authenticated producer once to seed the existing backlog.
9. Monitor producer/consumer/DLQ logs and Queue backlog until work settles.
10. Query database aggregates to verify healthy stale users advance across the
   entire GitHub-ID distribution rather than only the original prefix.
11. Confirm Cron and Queue invocations stay within configured batch/concurrency
   bounds and do not show CPU, memory, or subrequest-limit outcomes.
12. Remove the canary Worker and isolated queues only after production
    acceptance evidence has been retained.

Cron changes may take up to 15 minutes to propagate. Queue processing and the
database are the source of truth during rollout, not a successful deploy command
alone.

## Immediate Live Acceptance Criteria

- The Cloudflare deployment contains the primary Queue producer/consumer
  binding and DLQ configuration.
- The live Cron is hourly and the prior `0 0 */3 * *` schedule is absent.
- The initial producer enqueues the pre-existing stale population without a
  direct all-users refresh.
- Healthy users beyond the original first-50 GitHub-ID prefix receive new
  checkpoints.
- The healthy stale backlog drains to zero; any remaining rows have an explicit
  reconnect, retry, or terminal failure state.
- No primary queue consumer invocation receives more than one user or attempts
  more than 40 GitHub HTTP requests.
- DLQ messages are reconciled into sanitized database records while PostgreSQL
  is available.
- No refresh invocation reports `exceededCpu`, `exceededMemory`, or too many
  subrequests.
- Canary forced-failure verification produces a failed Cloudflare outcome,
  while healthy production runs produce structured completion logs. No forced
  failure is injected into the live production scheduler.
- Full tests, type checking, scheduler-specific lint, and production build pass,
  with unrelated pre-existing lint failures called out explicitly if still
  present.

These criteria establish that the fix is deployed and functioning; they do not
pretend that a 60-hour cadence has already been observed.

## Deferred Steady-State Acceptance

Keep an automated database/Cloudflare monitor active through at least one full
60-hour refresh cycle after backlog drain. At that checkpoint:

- every healthy connected user's checkpoint age remains below 72 hours;
- the same users do not monopolize consecutive producer pages;
- primary, DLQ, and Free-plan daily operation budgets remain within their
  configured limits;
- any exception is tied to an explicit reconnect, retry, terminal, or active
  incident state.

Report the immediate deployment gate separately from this deferred burn-in. Do
not claim the 72-hour steady-state property as live-verified until the monitor
has actually observed the full cycle.

## Rollback

The database migration is additive and remains compatible with the previous
Worker. A Cloudflare code rollback does not roll back Cron Triggers, Queue
consumers, bindings, or other connected resources. If rollout fails:

1. remove or pause both Queue consumers so no message is delivered to old code;
2. explicitly remove the hourly Cron and verify the trigger list is empty;
3. verify no primary or DLQ invocation remains in flight;
4. roll traffic back to Worker version 32 for HTTP service only;
5. leave queued messages, Queue bindings, additive columns, and failure rows
   intact for diagnosis;
6. do not restore version 32's known-broken every-three-days refresh unless the
   user explicitly accepts that degraded behavior;
7. correct the issue, redeploy forward, reattach consumers, and restore the
   hourly producer only after verification.

No destructive database rollback is required.

## Deferred Follow-Up

After this scheduler is implemented, deployed, and live-verified, separately
design:

- public username lookup without sign-in;
- seeded, clearly unverified public developer profiles;
- profile linking and ownership verification;
- public versus authorized refresh credentials and cadences;
- contribution/commit metric semantics, only when the user elects to revisit
  them.
