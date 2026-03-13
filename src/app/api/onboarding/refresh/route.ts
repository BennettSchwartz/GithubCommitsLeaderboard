import { NextRequest } from "next/server";

import { createRateLimitedResponse, createServerErrorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { readSessionCookie } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await enforceRateLimit(request, "onboarding");
    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const session = await readSessionCookie();
    if (!session) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(data: Record<string, unknown>) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }

        try {
          const { getRuntimeEnv } = await import("@/lib/runtime-env");
          const { decryptText } = await import("@/lib/crypto");
          const { buildYearlyContributionWindows, fetchCommitContributionTotal } = await import("@/lib/github");
          const { Client } = await import("pg");

          const env = await getRuntimeEnv();

          if (!env.TOKEN_ENCRYPTION_KEY) {
            sendEvent({ type: "error", message: "Server configuration error" });
            controller.close();
            return;
          }

          const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
          if (!connectionString) {
            sendEvent({ type: "error", message: "Database not available" });
            controller.close();
            return;
          }

          const client = new Client({ connectionString });
          await client.connect();

          try {
            const userResult = await client.query<{
              github_created_at: Date;
              all_time_commits: number;
              last_checked_at: Date | null;
              access_token_encrypted: string;
            }>(
              `SELECT u.github_created_at, s.all_time_commits, s.last_checked_at, t.access_token_encrypted
               FROM users u
               JOIN scores s ON s.user_id = u.id
               JOIN tokens t ON t.user_id = u.id
               WHERE u.id = $1`,
              [session.userId],
            );

            const user = userResult.rows[0];
            if (!user) {
              sendEvent({ type: "error", message: "User not found" });
              controller.close();
              return;
            }

            const accessToken = await decryptText(env.TOKEN_ENCRYPTION_KEY, user.access_token_encrypted);
            const now = new Date();

            let totalCommits: number;

            if (user.last_checked_at) {
              // Incremental refresh
              const fromDate = new Date(user.last_checked_at.getTime() + 1);
              if (fromDate >= now) {
                totalCommits = user.all_time_commits;
              } else {
                sendEvent({ type: "progress", window: 1, total: 1, commitsSoFar: user.all_time_commits, yearLabel: "Updating..." });
                const delta = await fetchCommitContributionTotal(accessToken, fromDate.toISOString(), now.toISOString());
                totalCommits = user.all_time_commits + delta;
              }
            } else {
              // Full computation with yearly windows
              const windows = buildYearlyContributionWindows(user.github_created_at.toISOString(), now);
              totalCommits = 0;

              for (let i = 0; i < windows.length; i++) {
                const w = windows[i];
                const fromYear = new Date(w.from).getUTCFullYear();
                const toYear = new Date(w.to).getUTCFullYear();
                const yearLabel = fromYear === toYear ? String(fromYear) : `${fromYear}–${toYear}`;

                const windowCommits = await fetchCommitContributionTotal(accessToken, w.from, w.to);
                totalCommits += windowCommits;

                sendEvent({
                  type: "progress",
                  window: i + 1,
                  total: windows.length,
                  commitsSoFar: totalCommits,
                  yearLabel,
                });
              }
            }

            // Save score
            const checkedAt = now.toISOString();
            await client.query(
              `UPDATE scores SET all_time_commits = $2, last_checked_at = $3, last_updated_at = $3 WHERE user_id = $1`,
              [session.userId, totalCommits, checkedAt],
            );

            // Bump leaderboard version
            await client.query(`
              INSERT INTO app_meta (key, value, updated_at)
              VALUES ('leaderboard_version', '2', NOW())
              ON CONFLICT (key)
              DO UPDATE SET value = ((app_meta.value)::integer + 1)::text, updated_at = NOW()
            `);

            // Compute rank
            const rankResult = await client.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count
               FROM users u JOIN scores s ON s.user_id = u.id
               WHERE u.needs_reconnect = FALSE
                 AND (s.all_time_commits > $1 OR (s.all_time_commits = $1 AND u.github_id < $2))`,
              [totalCommits, session.githubId],
            );
            const rank = Number(rankResult.rows[0]?.count ?? "0") + 1;

            // Total users for percentile
            const countResult = await client.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM users WHERE needs_reconnect = FALSE`,
            );
            const totalUsers = Number(countResult.rows[0]?.count ?? "0");
            const percentile = Math.max(1, Math.ceil((1 - (rank - 1) / totalUsers) * 100));

            // Record score history
            await client.query(
              `INSERT INTO score_history (user_id, all_time_commits, recorded_at) VALUES ($1, $2, $3)`,
              [session.userId, totalCommits, checkedAt],
            );

            sendEvent({
              type: "complete",
              rank,
              percentile,
              totalCommits,
              login: session.login,
              name: session.name,
              avatarUrl: session.avatarUrl,
            });
          } finally {
            await client.end();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Processing failed";
          sendEvent({ type: "error", message });
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
