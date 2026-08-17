import { decodeCursor, encodeCursor } from "./cursor";
import { encryptText } from "./crypto";
import {
  withDb,
  withRefreshDb,
  withTransaction,
  type Queryable,
} from "./postgres";
import type {
  GitHubIdentity,
  LeaderboardEntry,
  LeaderboardResponse,
  RankLookupResponse,
  SessionUser,
  UserLookupResponse,
} from "./types";

type LeaderboardRow = {
  github_id: string;
  login: string;
  name: string | null;
  avatar_url: string;
  profile_url: string;
  github_created_at: Date;
  all_time_commits: number;
  last_updated_at: Date | null;
};

function normalizeLogin(login: string) {
  return login.replace(/^@+/, "").trim().toLowerCase();
}

function mapLeaderboardRow(row: LeaderboardRow, rank: number): LeaderboardEntry {
  return {
    rank,
    githubId: Number(row.github_id),
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
    githubCreatedAt: row.github_created_at.toISOString(),
    allTimeCommits: row.all_time_commits,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
  };
}

async function getLeaderboardVersion(client: Queryable) {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'leaderboard_version'",
  );

  return Number(result.rows[0]?.value ?? "1");
}

async function getStartingRank(client: Queryable, commits: number, githubId: number) {
  const result = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM users u
      JOIN scores s ON s.user_id = u.id
      WHERE u.needs_reconnect = FALSE
        AND (
          s.all_time_commits > $1
          OR (s.all_time_commits = $1 AND u.github_id <= $2)
        )
    `,
    [commits, githubId],
  );

  return Number(result.rows[0]?.count ?? "0") + 1;
}

export async function getTotalUserCount(): Promise<number> {
  return withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE needs_reconnect = FALSE`,
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

export async function listLeaderboard(limit = 50, rawCursor?: string | null): Promise<LeaderboardResponse> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);

  return withDb(async (client) => {
    const cursor = decodeCursor(rawCursor);
    const version = await getLeaderboardVersion(client);
    const startingRank = cursor ? await getStartingRank(client, cursor.commits, cursor.githubId) : 1;

    const rows = await client.query<LeaderboardRow>(
      `
        SELECT
          u.github_id,
          u.login,
          u.name,
          u.avatar_url,
          u.profile_url,
          u.github_created_at,
          s.all_time_commits,
          s.last_updated_at
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.needs_reconnect = FALSE
          AND (
            $1::integer IS NULL
            OR s.all_time_commits < $1
            OR (s.all_time_commits = $1 AND u.github_id > $2)
          )
        ORDER BY s.all_time_commits DESC, u.github_id ASC
        LIMIT $3
      `,
      [cursor?.commits ?? null, cursor?.githubId ?? null, safeLimit],
    );

    const lastRow = rows.rows.at(-1);

    return {
      version,
      generatedAt: new Date().toISOString(),
      startingRank,
      nextCursor: lastRow
        ? encodeCursor({
            commits: lastRow.all_time_commits,
            githubId: Number(lastRow.github_id),
          })
        : null,
      source: "database",
      data: rows.rows.map((row, index) => mapLeaderboardRow(row, startingRank + index)),
    } satisfies LeaderboardResponse;
  });
}

export async function findUserByLogin(login: string): Promise<UserLookupResponse> {
  const normalized = normalizeLogin(login);

  return withDb(async (client) => {
    const version = await getLeaderboardVersion(client);
    const userResult = await client.query<LeaderboardRow>(
      `
        SELECT
          u.github_id,
          u.login,
          u.name,
          u.avatar_url,
          u.profile_url,
          u.github_created_at,
          s.all_time_commits,
          s.last_updated_at
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.login_lc = $1
          AND u.needs_reconnect = FALSE
        LIMIT 1
      `,
      [normalized],
    );

    const row = userResult.rows[0];

    if (!row) {
      return {
        version,
        generatedAt: new Date().toISOString(),
        found: false,
        source: "database",
        data: null,
      } satisfies UserLookupResponse;
    }

    const rankResult = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.needs_reconnect = FALSE
          AND (
            s.all_time_commits > $1
            OR (s.all_time_commits = $1 AND u.github_id < $2)
          )
      `,
      [row.all_time_commits, row.github_id],
    );

    const rank = Number(rankResult.rows[0]?.count ?? "0") + 1;

    return {
      version,
      generatedAt: new Date().toISOString(),
      found: true,
      source: "database",
      data: mapLeaderboardRow(row, rank),
    } satisfies UserLookupResponse;
  });
}

export async function findUserByLoginWithCount(login: string): Promise<UserLookupResponse & { totalUsers: number }> {
  const normalized = normalizeLogin(login);

  return withDb(async (client) => {
    const version = await getLeaderboardVersion(client);

    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE needs_reconnect = FALSE`,
    );
    const totalUsers = Number(countResult.rows[0]?.count ?? "0");

    const userResult = await client.query<LeaderboardRow>(
      `
        SELECT
          u.github_id,
          u.login,
          u.name,
          u.avatar_url,
          u.profile_url,
          u.github_created_at,
          s.all_time_commits,
          s.last_updated_at
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.login_lc = $1
          AND u.needs_reconnect = FALSE
        LIMIT 1
      `,
      [normalized],
    );

    const row = userResult.rows[0];

    if (!row) {
      return {
        version,
        generatedAt: new Date().toISOString(),
        found: false,
        source: "database",
        data: null,
        totalUsers,
      } satisfies UserLookupResponse & { totalUsers: number };
    }

    const rankResult = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.needs_reconnect = FALSE
          AND (
            s.all_time_commits > $1
            OR (s.all_time_commits = $1 AND u.github_id < $2)
          )
      `,
      [row.all_time_commits, row.github_id],
    );

    const rank = Number(rankResult.rows[0]?.count ?? "0") + 1;

    return {
      version,
      generatedAt: new Date().toISOString(),
      found: true,
      source: "database",
      data: mapLeaderboardRow(row, rank),
      totalUsers,
    } satisfies UserLookupResponse & { totalUsers: number };
  });
}

export async function getScoreHistory(
  login: string,
  since: Date,
): Promise<{ allTimeCommits: number; recordedAt: string }[]> {
  const normalized = normalizeLogin(login);

  return withDb(async (client) => {
    const result = await client.query<{
      all_time_commits: number;
      recorded_at: Date;
    }>(
      `
        SELECT sh.all_time_commits, sh.recorded_at
        FROM score_history sh
        JOIN users u ON u.id = sh.user_id
        WHERE u.login_lc = $1
          AND sh.recorded_at >= $2
        ORDER BY sh.recorded_at ASC
      `,
      [normalized, since],
    );

    return result.rows.map((row) => ({
      allTimeCommits: row.all_time_commits,
      recordedAt: row.recorded_at.toISOString(),
    }));
  });
}

export async function getRankAtCommits(commits: number, githubId: number): Promise<number> {
  return withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.needs_reconnect = FALSE
          AND (
            s.all_time_commits > $1
            OR (s.all_time_commits = $1 AND u.github_id < $2)
          )
      `,
      [commits, githubId],
    );
    return Number(result.rows[0]?.count ?? "0") + 1;
  });
}

export async function listTimeBased(days: number, limit = 50): Promise<{
  days: number;
  generatedAt: string;
  data: (LeaderboardEntry & { commitsDelta: number })[];
}> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return withDb(async (client) => {
    // For each user, get their earliest score_history entry in the window
    // and compute delta = current commits - earliest snapshot
    const result = await client.query<LeaderboardRow & { commits_delta: number }>(
      `
        SELECT
          u.github_id,
          u.login,
          u.name,
          u.avatar_url,
          u.profile_url,
          u.github_created_at,
          s.all_time_commits,
          s.last_updated_at,
          (s.all_time_commits - earliest.all_time_commits) AS commits_delta
        FROM users u
        JOIN scores s ON s.user_id = u.id
        JOIN LATERAL (
          SELECT sh.all_time_commits
          FROM score_history sh
          WHERE sh.user_id = u.id
            AND sh.recorded_at >= $1
          ORDER BY sh.recorded_at ASC
          LIMIT 1
        ) earliest ON TRUE
        WHERE u.needs_reconnect = FALSE
          AND (s.all_time_commits - earliest.all_time_commits) > 0
        ORDER BY (s.all_time_commits - earliest.all_time_commits) DESC, u.github_id ASC
        LIMIT $2
      `,
      [since, safeLimit],
    );

    return {
      days,
      generatedAt: new Date().toISOString(),
      data: result.rows.map((row, index) => ({
        ...mapLeaderboardRow(row, index + 1),
        commitsDelta: row.commits_delta,
      })),
    };
  });
}

export async function findUserByRank(rank: number): Promise<RankLookupResponse> {
  return withDb(async (client) => {
    const version = await getLeaderboardVersion(client);
    const result = await client.query<LeaderboardRow>(
      `
        SELECT
          u.github_id,
          u.login,
          u.name,
          u.avatar_url,
          u.profile_url,
          u.github_created_at,
          s.all_time_commits,
          s.last_updated_at
        FROM users u
        JOIN scores s ON s.user_id = u.id
        WHERE u.needs_reconnect = FALSE
        ORDER BY s.all_time_commits DESC, u.github_id ASC
        OFFSET $1
        LIMIT 1
      `,
      [rank - 1],
    );

    const row = result.rows[0];

    return {
      version,
      generatedAt: new Date().toISOString(),
      found: Boolean(row),
      source: "database",
      data: row ? mapLeaderboardRow(row, rank) : null,
    } satisfies RankLookupResponse;
  });
}

export async function upsertConnectedUser(
  identity: GitHubIdentity,
  accessToken: string,
  options?: {
    testHooks?: {
      afterLock?: (event: {
        operation: "oauth_replacement";
        relation: "users" | "tokens" | "scores";
        userId: string;
      }) => Promise<void>;
    };
  },
) {
  return withRefreshDb(async (client, env) => {
    if (!env.TOKEN_ENCRYPTION_KEY) {
      throw new Error("TOKEN_ENCRYPTION_KEY is required to store OAuth tokens");
    }

    const encryptedToken = await encryptText(env.TOKEN_ENCRYPTION_KEY, accessToken);
    const staleLoginReplacement = `renamed-${identity.githubId}`;

    return withTransaction(client, async (transaction) => {
      const capacity = await transaction.query(
        "SELECT generation FROM refresh_capacity_control WHERE singleton = TRUE FOR UPDATE",
      );
      if (capacity.rowCount !== 1) {
        throw new Error("missing refresh_capacity_control singleton");
      }
      await transaction.query(
        `
          UPDATE refresh_capacity_control
          SET generation = generation + 1,
              evaluated_at = NULL,
              valid_until = NULL,
              forecast_sha256 = NULL
          WHERE singleton = TRUE
        `,
      );

      await transaction.query(
        `
          UPDATE users
          SET login = $1, login_lc = $1, updated_at = NOW()
          WHERE login_lc = $2
            AND github_id <> $3
        `,
        [staleLoginReplacement, identity.login.toLowerCase(), identity.githubId],
      );

      const userResult = await transaction.query<{ id: string }>(
        `
          INSERT INTO users (
            github_id,
            login,
            login_lc,
            name,
            avatar_url,
            profile_url,
            github_created_at,
            needs_reconnect,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())
          ON CONFLICT (github_id)
          DO UPDATE SET
            login = EXCLUDED.login,
            login_lc = EXCLUDED.login_lc,
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            profile_url = EXCLUDED.profile_url,
            github_created_at = EXCLUDED.github_created_at,
            needs_reconnect = FALSE,
            updated_at = NOW()
          RETURNING id
        `,
        [
          identity.githubId,
          identity.login,
          identity.login.toLowerCase(),
          identity.name,
          identity.avatarUrl,
          identity.profileUrl,
          identity.createdAt,
        ],
      );

      const userId = userResult.rows[0]?.id;

      if (!userId) {
        throw new Error("Failed to upsert GitHub user");
      }
      await options?.testHooks?.afterLock?.({
        operation: "oauth_replacement",
        relation: "users",
        userId,
      });

      await transaction.query(
        `
          INSERT INTO tokens (user_id, access_token_encrypted, updated_at)
          VALUES ($1, $2, clock_timestamp())
          ON CONFLICT (user_id)
          DO UPDATE SET
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            updated_at = GREATEST(clock_timestamp(), tokens.updated_at + INTERVAL '1 microsecond')
        `,
        [userId, encryptedToken],
      );
      await options?.testHooks?.afterLock?.({
        operation: "oauth_replacement",
        relation: "tokens",
        userId,
      });

      await transaction.query(
        `
          INSERT INTO scores (
            user_id, all_time_commits, last_checked_at, last_updated_at, next_refresh_at
          )
          VALUES ($1, 0, NULL, NULL, clock_timestamp())
          ON CONFLICT (user_id)
          DO UPDATE SET
            refresh_claim_id = NULL,
            refresh_target_at = NULL,
            refresh_claimed_until = NULL,
            last_refresh_error_code = NULL,
            next_refresh_at = COALESCE(
              scores.last_checked_at + INTERVAL '60 hours',
              clock_timestamp()
            )
        `,
        [userId],
      );
      await options?.testHooks?.afterLock?.({
        operation: "oauth_replacement",
        relation: "scores",
        userId,
      });

      return {
        userId,
        githubId: identity.githubId,
        login: identity.login,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
      } satisfies SessionUser;
    });
  });
}

export async function getConnectedSessionUser(userId: string) {
  return withDb(async (client) => {
    const result = await client.query<{
      id: string;
      github_id: string;
      login: string;
      name: string | null;
      avatar_url: string;
    }>(
      `
        SELECT id, github_id, login, name, avatar_url
        FROM users
        WHERE id = $1
          AND needs_reconnect = FALSE
        LIMIT 1
      `,
      [userId],
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      userId: row.id,
      githubId: Number(row.github_id),
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
    } satisfies SessionUser;
  });
}
