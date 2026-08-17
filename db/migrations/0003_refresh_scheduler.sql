LOCK TABLE users, tokens, scores, score_history
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE scores
  ADD COLUMN IF NOT EXISTS refresh_claim_id UUID,
  ADD COLUMN IF NOT EXISTS refresh_target_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_claimed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_fail_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_refresh_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_refresh_error_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scores_refresh_error_category_check'
      AND conrelid = 'scores'::regclass
  ) THEN
    ALTER TABLE scores ADD CONSTRAINT scores_refresh_error_category_check
      CHECK (last_refresh_error_code IS NULL OR last_refresh_error_code IN (
        'auth', 'rate_limit', 'github_5xx', 'github_transient',
        'github_terminal', 'database', 'unknown'
      ));
  END IF;
END;
$$;

ALTER TABLE score_history
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audit_user_id UUID;

ALTER TABLE score_history
  DROP CONSTRAINT score_history_user_id_fkey,
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE score_history
  ADD CONSTRAINT score_history_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

UPDATE score_history
SET committed_at = COALESCE(committed_at, recorded_at),
    audit_user_id = COALESCE(audit_user_id, user_id)
WHERE committed_at IS NULL OR audit_user_id IS NULL;

ALTER TABLE score_history
  ALTER COLUMN committed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN committed_at SET NOT NULL,
  ALTER COLUMN audit_user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS score_history_audit_user_committed_idx
  ON score_history (audit_user_id, committed_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM score_history
    GROUP BY audit_user_id, recorded_at
    HAVING COUNT(DISTINCT all_time_commits) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'conflicting score history checkpoint';
  END IF;
END;
$$;

WITH latest_history AS (
  SELECT DISTINCT ON (user_id)
    user_id, all_time_commits, recorded_at
  FROM score_history
  ORDER BY user_id, recorded_at DESC, id DESC
)
UPDATE scores s
SET
  all_time_commits = h.all_time_commits,
  last_checked_at = h.recorded_at,
  last_updated_at = h.recorded_at
FROM latest_history h
WHERE h.user_id = s.user_id
  AND (s.last_checked_at IS NULL OR h.recorded_at > s.last_checked_at);

WITH migration_clock AS (
  SELECT statement_timestamp() AS applied_at
)
UPDATE scores s
SET next_refresh_at = COALESCE(
  s.next_refresh_at,
  s.last_checked_at + INTERVAL '60 hours',
  migration_clock.applied_at
)
FROM users u, migration_clock
WHERE u.id = s.user_id
  AND u.needs_reconnect = FALSE
  AND EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = u.id)
  AND s.next_refresh_at IS NULL;

CREATE INDEX IF NOT EXISTS scores_refresh_due_idx
  ON scores (next_refresh_at, user_id)
  INCLUDE (refresh_claimed_until);

CREATE TABLE IF NOT EXISTS refresh_dead_letters (
  queue_message_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  audit_user_id UUID,
  claim_id UUID,
  attempt_event_key TEXT CHECK (
    attempt_event_key IS NULL OR attempt_event_key ~ '^[a-f0-9]{64}$'
  ),
  error_category TEXT NOT NULL CHECK (error_category IN (
    'auth', 'rate_limit', 'github_5xx', 'github_transient',
    'github_terminal', 'database', 'unknown', 'invalid_message'
  )),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  first_committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS refresh_attempt_events (
  event_key TEXT PRIMARY KEY CHECK (event_key ~ '^[a-f0-9]{64}$'),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  audit_user_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  category TEXT NOT NULL CHECK (category IN (
    'auth', 'rate_limit', 'github_5xx', 'github_transient',
    'github_terminal', 'database', 'unknown'
  )),
  disposition TEXT NOT NULL CHECK (disposition IN ('auth', 'retry', 'terminal', 'dlq')),
  CONSTRAINT refresh_attempt_events_disposition_category_check CHECK (
    (disposition = 'auth' AND category = 'auth') OR
    (disposition = 'retry' AND category IN (
      'rate_limit', 'github_5xx', 'github_transient', 'unknown'
    )) OR
    (disposition = 'terminal' AND category = 'github_terminal') OR
    disposition = 'dlq'
  )
);

CREATE INDEX IF NOT EXISTS refresh_attempt_events_time_category_user_idx
  ON refresh_attempt_events (attempted_at, category, user_id);

CREATE INDEX IF NOT EXISTS refresh_attempt_events_committed_idx
  ON refresh_attempt_events (committed_at, event_key);

CREATE INDEX IF NOT EXISTS refresh_attempt_events_user_idx
  ON refresh_attempt_events (user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'refresh_dead_letters_attempt_event_fk'
      AND conrelid = 'refresh_dead_letters'::regclass
  ) THEN
    ALTER TABLE refresh_dead_letters
      ADD CONSTRAINT refresh_dead_letters_attempt_event_fk
      FOREIGN KEY (attempt_event_key)
      REFERENCES refresh_attempt_events(event_key)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS refresh_dead_letters_first_committed_idx
  ON refresh_dead_letters (first_committed_at, queue_message_id);

CREATE INDEX IF NOT EXISTS refresh_dead_letters_user_idx
  ON refresh_dead_letters (user_id);

CREATE INDEX IF NOT EXISTS refresh_dead_letters_attempt_event_idx
  ON refresh_dead_letters (attempt_event_key);

CREATE OR REPLACE FUNCTION stamp_refresh_attempt_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'refresh attempt owner required';
  END IF;
  NEW.audit_user_id := NEW.user_id;
  NEW.committed_at := statement_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_attempt_events_stamp ON refresh_attempt_events;
CREATE TRIGGER refresh_attempt_events_stamp
BEFORE INSERT ON refresh_attempt_events
FOR EACH ROW EXECUTE FUNCTION stamp_refresh_attempt_event();

CREATE OR REPLACE FUNCTION protect_refresh_attempt_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refresh attempt events are append-only';
  END IF;
  IF OLD.user_id IS NOT NULL
     AND NEW.user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
     AND NEW.event_key = OLD.event_key
     AND NEW.audit_user_id = OLD.audit_user_id
     AND NEW.claim_id = OLD.claim_id
     AND NEW.attempted_at = OLD.attempted_at
     AND NEW.category = OLD.category
     AND NEW.disposition = OLD.disposition THEN
    NEW.committed_at := OLD.committed_at;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refresh attempt events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS refresh_attempt_events_append_only ON refresh_attempt_events;
CREATE TRIGGER refresh_attempt_events_append_only
BEFORE UPDATE OR DELETE ON refresh_attempt_events
FOR EACH ROW EXECUTE FUNCTION protect_refresh_attempt_event();

CREATE OR REPLACE FUNCTION stamp_refresh_dead_letter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refresh dead letters are append-only audits';
  ELSIF TG_OP = 'INSERT' THEN
    NEW.audit_user_id := NEW.user_id;
    NEW.first_committed_at := statement_timestamp();
    NEW.last_committed_at := NEW.first_committed_at;
  ELSE
    IF NEW.queue_message_id IS DISTINCT FROM OLD.queue_message_id
       OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
       OR NEW.audit_user_id IS DISTINCT FROM OLD.audit_user_id
       OR (
         NEW.attempt_event_key IS DISTINCT FROM OLD.attempt_event_key
         AND NOT (OLD.attempt_event_key IS NULL AND NEW.attempt_event_key IS NOT NULL)
       )
       OR NEW.error_category IS DISTINCT FROM OLD.error_category
       OR NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at
       OR (NEW.user_id IS DISTINCT FROM OLD.user_id
           AND NOT (
             OLD.user_id IS NOT NULL
             AND NEW.user_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
           ))
       OR NEW.last_observed_at < OLD.last_observed_at
       OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'immutable refresh dead-letter audit field';
    END IF;
    NEW.first_committed_at := OLD.first_committed_at;
    IF NEW.last_observed_at IS DISTINCT FROM OLD.last_observed_at
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
      NEW.last_committed_at := statement_timestamp();
    ELSE
      NEW.last_committed_at := OLD.last_committed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_dead_letters_stamp_insert ON refresh_dead_letters;
CREATE TRIGGER refresh_dead_letters_stamp_insert
BEFORE INSERT ON refresh_dead_letters
FOR EACH ROW EXECUTE FUNCTION stamp_refresh_dead_letter();

DROP TRIGGER IF EXISTS refresh_dead_letters_stamp_update ON refresh_dead_letters;
CREATE TRIGGER refresh_dead_letters_stamp_update
BEFORE UPDATE OR DELETE ON refresh_dead_letters
FOR EACH ROW EXECUTE FUNCTION stamp_refresh_dead_letter();

CREATE TABLE IF NOT EXISTS refresh_legacy_reconnect_candidates (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_updated_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

INSERT INTO refresh_legacy_reconnect_candidates (
  user_id, token_updated_at, observed_at, resolved_at
)
SELECT u.id, t.updated_at, clock_timestamp(), NULL
FROM users u
JOIN tokens t ON t.user_id = u.id
WHERE u.needs_reconnect = TRUE
  AND u.updated_at >= transaction_timestamp() - INTERVAL '16 minutes'
ON CONFLICT (user_id) DO UPDATE SET
  token_updated_at = EXCLUDED.token_updated_at,
  observed_at = EXCLUDED.observed_at,
  resolved_at = NULL;

INSERT INTO app_meta (key, value, updated_at)
VALUES ('refresh_writer_generation', 'legacy', clock_timestamp())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS refresh_capacity_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  evaluated_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  forecast_sha256 TEXT CHECK (
    forecast_sha256 IS NULL OR forecast_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CHECK (
    (evaluated_at IS NULL AND valid_until IS NULL AND forecast_sha256 IS NULL)
    OR
    (evaluated_at IS NOT NULL AND valid_until IS NOT NULL
      AND valid_until = evaluated_at + INTERVAL '6 hours'
      AND forecast_sha256 IS NOT NULL)
  )
);

INSERT INTO refresh_capacity_control (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_refresh_writer_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_generation TEXT;
  actual_generation TEXT;
BEGIN
  SELECT value
  INTO required_generation
  FROM app_meta
  WHERE key = 'refresh_writer_generation'
  FOR SHARE;

  IF required_generation NOT IN ('legacy', 'queue_v1') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'invalid refresh writer generation';
  END IF;

  actual_generation := COALESCE(
    NULLIF(current_setting('gcl.refresh_writer_generation', TRUE), ''),
    'legacy'
  );

  IF actual_generation IS DISTINCT FROM required_generation THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refresh writer generation rejected';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS users_refresh_writer_generation ON users;
CREATE TRIGGER users_refresh_writer_generation
BEFORE INSERT OR UPDATE OR DELETE ON users
FOR EACH STATEMENT EXECUTE FUNCTION enforce_refresh_writer_generation();

DROP TRIGGER IF EXISTS tokens_refresh_writer_generation ON tokens;
CREATE TRIGGER tokens_refresh_writer_generation
BEFORE INSERT OR UPDATE OR DELETE ON tokens
FOR EACH STATEMENT EXECUTE FUNCTION enforce_refresh_writer_generation();

DROP TRIGGER IF EXISTS scores_refresh_writer_generation ON scores;
CREATE TRIGGER scores_refresh_writer_generation
BEFORE INSERT OR UPDATE OR DELETE ON scores
FOR EACH STATEMENT EXECUTE FUNCTION enforce_refresh_writer_generation();

DROP TRIGGER IF EXISTS score_history_refresh_writer_generation ON score_history;
CREATE TRIGGER score_history_refresh_writer_generation
BEFORE INSERT OR UPDATE OR DELETE ON score_history
FOR EACH STATEMENT EXECUTE FUNCTION enforce_refresh_writer_generation();

CREATE OR REPLACE FUNCTION normalize_refresh_score_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.next_refresh_at := COALESCE(
      NEW.next_refresh_at,
      NEW.last_checked_at + INTERVAL '60 hours',
      clock_timestamp()
    );
    RETURN NEW;
  END IF;

  IF (
    OLD.last_checked_at IS NULL AND NEW.last_checked_at IS NULL
  ) OR (
    OLD.last_checked_at IS NOT NULL
    AND (NEW.last_checked_at IS NULL OR NEW.last_checked_at <= OLD.last_checked_at)
  ) THEN
    NEW.all_time_commits := OLD.all_time_commits;
    NEW.last_checked_at := OLD.last_checked_at;
    NEW.last_updated_at := OLD.last_updated_at;
    RETURN NEW;
  END IF;

  NEW.next_refresh_at := NEW.last_checked_at + INTERVAL '60 hours';
  NEW.refresh_claim_id := NULL;
  NEW.refresh_target_at := NULL;
  NEW.refresh_claimed_until := NULL;
  NEW.last_refresh_error_code := NULL;
  NEW.refresh_fail_count := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scores_refresh_compatibility ON scores;
CREATE TRIGGER scores_refresh_compatibility
BEFORE INSERT OR UPDATE ON scores
FOR EACH ROW EXECUTE FUNCTION normalize_refresh_score_write();

CREATE OR REPLACE FUNCTION enforce_current_score_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_score INTEGER;
  current_checkpoint TIMESTAMPTZ;
  write_clock TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id FOR KEY SHARE;
  SELECT all_time_commits, last_checked_at
  INTO current_score, current_checkpoint
  FROM scores
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  IF current_checkpoint IS DISTINCT FROM NEW.recorded_at
     OR current_score IS DISTINCT FROM NEW.all_time_commits THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM score_history
    WHERE user_id = NEW.user_id
      AND recorded_at = NEW.recorded_at
      AND all_time_commits <> NEW.all_time_commits
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'conflicting score history checkpoint';
  END IF;

  IF EXISTS (
    SELECT 1 FROM score_history
    WHERE user_id = NEW.user_id
      AND recorded_at = NEW.recorded_at
      AND all_time_commits = NEW.all_time_commits
  ) THEN
    RETURN NULL;
  END IF;

  write_clock := clock_timestamp();
  IF NEW.recorded_at > write_clock THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = 'future score history checkpoint';
  END IF;

  NEW.committed_at := write_clock;
  NEW.audit_user_id := NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS score_history_current_score ON score_history;
CREATE TRIGGER score_history_current_score
BEFORE INSERT ON score_history
FOR EACH ROW EXECUTE FUNCTION enforce_current_score_history();

CREATE OR REPLACE FUNCTION protect_score_history_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.user_id IS NOT NULL
     AND NEW.user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
     AND NEW.id = OLD.id
     AND NEW.audit_user_id = OLD.audit_user_id
     AND NEW.all_time_commits = OLD.all_time_commits
     AND NEW.recorded_at = OLD.recorded_at
     AND NEW.committed_at = OLD.committed_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'score history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS score_history_append_only ON score_history;
CREATE TRIGGER score_history_append_only
BEFORE UPDATE OR DELETE ON score_history
FOR EACH ROW EXECUTE FUNCTION protect_score_history_audit();

CREATE OR REPLACE FUNCTION capture_legacy_reconnect_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.needs_reconnect = FALSE
     AND NEW.needs_reconnect = TRUE
     AND COALESCE(NULLIF(current_setting('gcl.refresh_writer_generation', TRUE), ''), 'legacy') = 'legacy' THEN
    INSERT INTO refresh_legacy_reconnect_candidates (
      user_id, token_updated_at, observed_at, resolved_at
    )
    SELECT NEW.id, t.updated_at, clock_timestamp(), NULL
    FROM tokens t
    WHERE t.user_id = NEW.id
    ON CONFLICT (user_id) DO UPDATE SET
      token_updated_at = EXCLUDED.token_updated_at,
      observed_at = EXCLUDED.observed_at,
      resolved_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_capture_legacy_reconnect ON users;
CREATE TRIGGER users_capture_legacy_reconnect
AFTER UPDATE OF needs_reconnect ON users
FOR EACH ROW EXECUTE FUNCTION capture_legacy_reconnect_candidate();
