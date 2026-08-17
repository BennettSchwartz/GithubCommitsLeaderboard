export type CursorPayload = {
  commits: number;
  githubId: number;
};

export type LeaderboardEntry = {
  rank: number;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  githubCreatedAt: string;
  allTimeCommits: number;
  lastUpdatedAt: string | null;
};

export type LeaderboardResponse = {
  version: number;
  generatedAt: string;
  startingRank: number;
  nextCursor: string | null;
  data: LeaderboardEntry[];
  source: "database";
};

export type UserLookupResponse = {
  version: number;
  generatedAt: string;
  found: boolean;
  source: "database";
  data: LeaderboardEntry | null;
  totalUsers?: number;
};

export type RankLookupResponse = {
  version: number;
  generatedAt: string;
  found: boolean;
  source: "database";
  data: LeaderboardEntry | null;
};

export type SessionUser = {
  userId: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
};

export type GitHubIdentity = {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  createdAt: string;
};
