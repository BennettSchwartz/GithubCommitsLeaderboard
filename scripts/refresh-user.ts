import { decryptText } from "../src/lib/crypto";
import { runOnboardingRefresh } from "../src/lib/onboarding-refresh";
import { withRefreshDb } from "../src/lib/postgres";
import { refreshLogger } from "../src/lib/refresh-log";
import { createRefreshRepository } from "../src/lib/refresh-repository";
import { getRuntimeEnv } from "../src/lib/runtime-env";

async function refreshUserByLogin(login: string) {
  const env = await getRuntimeEnv();
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required");
  }

  const user = await withRefreshDb(
    async (client) => {
      const result = await client.query<{ id: string; login: string }>(
        `SELECT id, login
         FROM users
         WHERE login_lc = $1 AND needs_reconnect = FALSE
         LIMIT 1`,
        [login.replace(/^@+/, "").trim().toLowerCase()],
      );
      return result.rows[0] ?? null;
    },
    { env },
  );
  if (!user) throw new Error("User not found or needs reconnect");

  const result = await runOnboardingRefresh(
    {
      userId: user.id,
      targetAt: new Date().toISOString(),
      onProgress: (event) => {
        console.log(
          `Progress ${event.window}/${event.total}: ${event.commitsSoFar} commits`,
        );
      },
    },
    {
      repository: createRefreshRepository(env),
      decryptToken: (encrypted) =>
        decryptText(env.TOKEN_ENCRYPTION_KEY!, encrypted),
      fetchImpl: fetch,
      githubEndpoint: env.GITHUB_GRAPHQL_ENDPOINT,
      clock: () => new Date().toISOString(),
      logger: refreshLogger,
    },
  );

  console.log(`Updated ${user.login} to ${result.allTimeCommits} all-time commits`);
}

const login = process.argv[2];
if (!login) {
  console.error("Usage: npx tsx scripts/refresh-user.ts <github-login>");
  process.exit(1);
}

refreshUserByLogin(login).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
