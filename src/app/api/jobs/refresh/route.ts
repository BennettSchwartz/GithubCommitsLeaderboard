import { NextRequest } from "next/server";

import {
  createJsonResponse,
  createRateLimitedResponse,
  createServerErrorResponse,
} from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { authorizeAndEnqueueRefresh } from "@/lib/refresh-http";
import { refreshLogger } from "@/lib/refresh-log";
import { createRefreshRepository } from "@/lib/refresh-repository";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await enforceRateLimit(request, "jobs");

    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const env = await getRuntimeEnv();
    const authorization = request.headers.get("authorization");
    const result = await authorizeAndEnqueueRefresh(
      {
        authorization,
        expectedSecret: env.CRON_SECRET ?? "",
        targetAt: new Date().toISOString(),
      },
      {
        repository: createRefreshRepository(env),
        queue: env.REFRESH_QUEUE,
        clock: () => new Date().toISOString(),
        logger: refreshLogger,
      },
    );

    return createJsonResponse(result.body, { status: result.status });
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
