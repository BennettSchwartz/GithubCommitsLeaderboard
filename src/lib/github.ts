import { requireEnv } from "./runtime-env";
import type { GitHubIdentity } from "./types";

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

async function fetchGitHubGraphql<T>(accessToken: string, query: string, variables?: Record<string, unknown>) {
  const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "github-commits-leaderboard",
    },
    body: JSON.stringify({
      query,
      variables,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}`);
  }

  const payload = (await response.json()) as GraphQLResponse<T>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("GitHub GraphQL response was missing data");
  }

  return payload.data;
}

export async function exchangeCodeForAccessToken(code: string, redirectUri: string) {
  const env = await requireEnv(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
  const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-commits-leaderboard",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub OAuth token exchange failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "GitHub OAuth did not return an access token");
  }

  return payload.access_token;
}

export async function getViewerIdentity(accessToken: string) {
  const data = await fetchGitHubGraphql<{
    viewer: {
      databaseId: number | null;
      login: string;
      name: string | null;
      avatarUrl: string;
      url: string;
      createdAt: string;
    };
  }>(
    accessToken,
    `
      query ViewerIdentity {
        viewer {
          databaseId
          login
          name
          avatarUrl
          url
          createdAt
        }
      }
    `,
  );

  if (!data.viewer.databaseId) {
    throw new Error("GitHub did not return a numeric databaseId for the viewer");
  }

  return {
    githubId: data.viewer.databaseId,
    login: data.viewer.login,
    name: data.viewer.name,
    avatarUrl: data.viewer.avatarUrl,
    profileUrl: data.viewer.url,
    createdAt: data.viewer.createdAt,
  } satisfies GitHubIdentity;
}

export async function fetchCommitContributionTotal(
  accessToken: string,
  from: string,
  to: string,
) {
  const data = await fetchGitHubGraphql<{
    viewer: {
      contributionsCollection: {
        totalCommitContributions: number;
        restrictedContributionsCount: number;
      };
    };
  }>(
    accessToken,
    `
      query ContributionWindow($from: DateTime!, $to: DateTime!) {
        viewer {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }
    `,
    {
      from,
      to,
    },
  );

  // totalCommitContributions = public commits
  // restrictedContributionsCount = private repo contributions
  // Sum both to get true all-time commits
  const { totalCommitContributions, restrictedContributionsCount } = data.viewer.contributionsCollection;
  return totalCommitContributions + restrictedContributionsCount;
}

function endOfYearUtc(year: number) {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

export function buildYearlyContributionWindows(startIso: string, endDate = new Date()) {
  const start = new Date(startIso);
  const end = new Date(endDate);

  if (start >= end) {
    return [];
  }

  const windows: Array<{ from: string; to: string }> = [];
  let cursor = start;

  while (cursor < end) {
    const yearEnd = endOfYearUtc(cursor.getUTCFullYear());
    const windowEnd = yearEnd < end ? yearEnd : end;

    windows.push({
      from: cursor.toISOString(),
      to: windowEnd.toISOString(),
    });

    cursor = new Date(windowEnd.getTime() + 1);
  }

  return windows;
}

export async function computeAllTimeCommits(accessToken: string, githubCreatedAt: string, now = new Date()) {
  const windows = buildYearlyContributionWindows(githubCreatedAt, now);
  let total = 0;

  for (const window of windows) {
    total += await fetchCommitContributionTotal(accessToken, window.from, window.to);
  }

  return {
    total,
    checkedAt: now.toISOString(),
  };
}

export async function computeIncrementalCommits(accessToken: string, lastCheckedAt: string, now = new Date()) {
  const fromDate = new Date(new Date(lastCheckedAt).getTime() + 1);

  if (fromDate >= now) {
    return {
      delta: 0,
      checkedAt: now.toISOString(),
    };
  }

  const delta = await fetchCommitContributionTotal(accessToken, fromDate.toISOString(), now.toISOString());

  return {
    delta,
    checkedAt: now.toISOString(),
  };
}
