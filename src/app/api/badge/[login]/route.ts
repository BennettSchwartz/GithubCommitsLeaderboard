import { NextRequest } from "next/server";
import { z } from "zod";

import { renderRankedBadge, renderUnrankedBadge } from "@/lib/badge";
import { findUserByLogin } from "@/lib/db";
import { createRateLimitedResponse, createServerErrorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const loginSchema = z.string().trim().min(1).max(40);
const themeSchema = z.enum(["light", "dark"]).default("light");

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
    const stripped = login.replace(/\.svg$/i, "");
    const normalized = loginSchema.parse(stripped);

    const theme = themeSchema.parse(request.nextUrl.searchParams.get("theme") ?? undefined);

    const result = await findUserByLogin(normalized);

    const svg =
      result.data == null
        ? renderUnrankedBadge(theme)
        : renderRankedBadge(result.data.rank, theme);

    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
