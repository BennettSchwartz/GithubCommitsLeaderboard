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

export {
  GitHubRequestBudget,
  GitHubRequestError,
  buildYearlyContributionWindows,
  computeAllTimeCommits,
  computeIncrementalCommits,
  fetchCommitContributionTotal,
  requestGitHubGraphql,
} from "./github-refresh";

export type {
  ContributionWindow,
  GitHubContributionProgress,
  GitHubDeltaResult,
  GitHubErrorCode,
  GitHubRequestOptions,
  GitHubTotalResult,
} from "./github-refresh";
