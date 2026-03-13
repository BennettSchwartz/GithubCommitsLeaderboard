import { NextRequest } from "next/server";
import { z } from "zod";

import { listTimeBased } from "@/lib/db";
import {
  createJsonResponse,
  createRateLimitedResponse,
  createServerErrorResponse,
  withPublicApiCache,
} from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await enforceRateLimit(request, "leaderboard");

    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const searchParams = request.nextUrl.searchParams;
    const query = querySchema.parse({
      days: searchParams.get("days") ?? "90",
      limit: searchParams.get("limit") ?? "50",
    });

    const data = await listTimeBased(query.days, query.limit);

    return withPublicApiCache(createJsonResponse(data));
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
