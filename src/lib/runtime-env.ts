import { getCloudflareContext } from "@opennextjs/cloudflare";

import type {
  QueueProducerLike,
  RefreshMessageV1,
} from "./refresh-contract";

export type KvLike = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
};

export type HyperdriveLike = {
  connectionString: string;
};

export type RuntimeEnv = {
  APP_URL?: string;
  CRON_SECRET?: string;
  DATABASE_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_GRAPHQL_ENDPOINT?: string;
  HYPERDRIVE?: HyperdriveLike;
  REFRESH_HYPERDRIVE?: HyperdriveLike;
  REFRESH_EXPECTED_DATABASE?: string;
  REFRESH_EXPECTED_SCHEMA?: string;
  REFRESH_QUEUE: QueueProducerLike<RefreshMessageV1>;
  REFRESH_PRIMARY_QUEUE_NAME?: string;
  REFRESH_DLQ_NAME?: string;
  REFRESH_RETRY_BASE_SECONDS?: string;
  REFRESH_RETRY_CAP_SECONDS?: string;
  NEXT_PUBLIC_REPOSITORY_URL?: string;
  RATE_LIMITS?: KvLike;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

export async function getRuntimeEnv(overrides?: Partial<RuntimeEnv>) {
  const processEnv = process.env as unknown as RuntimeEnv;

  if (overrides) {
    return {
      ...processEnv,
      ...overrides,
    };
  }

  try {
    const { env } = await getCloudflareContext({ async: true });

    return {
      ...processEnv,
      ...(env as Partial<RuntimeEnv>),
    };
  } catch {
    return processEnv;
  }
}

export async function requireEnv(
  keys: Array<keyof RuntimeEnv>,
  overrides?: Partial<RuntimeEnv>,
) {
  const env = await getRuntimeEnv(overrides);

  for (const key of keys) {
    if (!env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return env as RuntimeEnv & Record<(typeof keys)[number], string>;
}
