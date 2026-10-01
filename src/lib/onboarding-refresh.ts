import type { GitHubContributionProgress } from "./github-refresh";
import {
  computeAllTimeCommits,
} from "./github-refresh";
import type { RefreshLogger } from "./refresh-log";
import type {
  CommittedRefreshResult,
  OnboardingSnapshot,
  RefreshRepository,
} from "./refresh-repository";

export type UserRefreshDependencies = {
  repository: RefreshRepository;
  decryptToken: (encrypted: string) => Promise<string>;
  fetchImpl: typeof fetch;
  githubEndpoint?: string;
  clock: () => string;
  logger: RefreshLogger;
};

export type OnboardingProgressEvent = GitHubContributionProgress;

export type OnboardingRefreshInput = {
  userId: string;
  targetAt: string;
  onProgress: (event: OnboardingProgressEvent) => void;
};

export class RefreshResultUnavailableError extends Error {
  readonly code = "REFRESH_RESULT_UNAVAILABLE" as const;

  constructor() {
    super("Committed refresh result is unavailable");
    this.name = "RefreshResultUnavailableError";
  }
}

export class OnboardingTokenChangedError extends Error {
  readonly code = "ONBOARDING_TOKEN_CHANGED" as const;

  constructor() {
    super("GitHub connection changed during refresh");
    this.name = "OnboardingTokenChangedError";
  }
}

export class OnboardingConnectionChangedError extends Error {
  readonly code = "ONBOARDING_CONNECTION_CHANGED" as const;

  constructor() {
    super("GitHub connection requires reconnection");
    this.name = "OnboardingConnectionChangedError";
  }
}

function timestampAtOrAfter(left: string, right: string) {
  return new Date(left).getTime() >= new Date(right).getTime();
}

async function requireCommittedResult(
  repository: RefreshRepository,
  userId: string,
): Promise<CommittedRefreshResult> {
  const result = await repository.loadCommittedRefreshResult(userId);
  if (!result) throw new RefreshResultUnavailableError();
  return result;
}

async function computeCandidate(
  snapshot: OnboardingSnapshot,
  input: OnboardingRefreshInput,
  deps: UserRefreshDependencies,
) {
  const token = await deps.decryptToken(snapshot.accessTokenEncrypted);
  const targetAt = new Date(snapshot.targetAt);
  const requestOptions = {
    fetchImpl: deps.fetchImpl,
    endpoint: deps.githubEndpoint,
  };

  // Full recount, not a delta: see refresh-consumer for why.
  const result = await computeAllTimeCommits(
    token,
    snapshot.githubCreatedAt,
    targetAt,
    { ...requestOptions, onProgress: input.onProgress },
  );
  return result.total;
}

export async function runOnboardingRefresh(
  input: OnboardingRefreshInput,
  deps: UserRefreshDependencies,
): Promise<CommittedRefreshResult> {
  // The request clock is telemetry only. The repository owns the target used by
  // GitHub and by the compare-and-swap write.
  if (!Number.isFinite(new Date(input.targetAt).getTime())) {
    throw new TypeError("targetAt must be a valid ISO timestamp");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const begin = await deps.repository.beginOnboardingAttempt(input.userId);
    if (begin.kind === "reconnect") {
      throw new OnboardingConnectionChangedError();
    }
    if (begin.kind === "missing") {
      throw new OnboardingTokenChangedError();
    }

    const { snapshot } = begin;
    if (
      snapshot.startingCheckpoint &&
      timestampAtOrAfter(snapshot.startingCheckpoint, snapshot.targetAt)
    ) {
      return requireCommittedResult(deps.repository, input.userId);
    }

    const candidate = await computeCandidate(snapshot, input, deps);
    const outcome = await deps.repository.completeOnboardingSuccess(
      snapshot,
      candidate,
    );

    if (outcome === "committed" || outcome === "stale_winner") {
      return requireCommittedResult(deps.repository, input.userId);
    }
    if (outcome === "stale_reconnect") {
      throw new OnboardingConnectionChangedError();
    }
    if (outcome === "stale_token" && attempt === 0) continue;
    throw new OnboardingTokenChangedError();
  }

  throw new OnboardingTokenChangedError();
}
