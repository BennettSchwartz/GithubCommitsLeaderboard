import { NextRequest } from "next/server";

import { getTotalUserCount } from "@/lib/db";
import {
  createJsonResponse,
  createRateLimitedResponse,
  createServerErrorResponse,
  withPublicApiCache,
} from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await enforceRateLimit(request, "leaderboard");

    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const totalUsers = await getTotalUserCount();

    return withPublicApiCache(
      createJsonResponse({
        generatedAt: new Date().toISOString(),
        totalUsers,
      }),
    );
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
