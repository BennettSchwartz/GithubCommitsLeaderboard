import { NextRequest } from "next/server";
import { z } from "zod";

import { getScoreHistory } from "@/lib/db";
import {
  createJsonResponse,
  createRateLimitedResponse,
  createServerErrorResponse,
  withPublicApiCache,
} from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const loginSchema = z.string().trim().min(1).max(40);

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      login: string;
    }>;
  },
) {
  try {
    const rateLimit = await enforceRateLimit(request, "user");

    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const { login } = await context.params;
    const normalized = loginSchema.parse(login);

    const days = Math.min(
      Math.max(parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const history = await getScoreHistory(normalized, since);

    return withPublicApiCache(
      createJsonResponse({
        login: normalized,
        days,
        history,
      }),
    );
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
