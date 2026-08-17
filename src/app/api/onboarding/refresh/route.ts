import { NextRequest } from "next/server";

import { createRateLimitedResponse, createServerErrorResponse } from "@/lib/http";
import {
  OnboardingConnectionChangedError,
  OnboardingTokenChangedError,
  RefreshResultUnavailableError,
  runOnboardingRefresh,
} from "@/lib/onboarding-refresh";
import { enforceRateLimit } from "@/lib/rate-limit";
import { refreshLogger } from "@/lib/refresh-log";
import { createRefreshRepository } from "@/lib/refresh-repository";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readSessionCookie } from "@/lib/session";
import { decryptText } from "@/lib/crypto";

function onboardingErrorMessage(error: unknown) {
  if (error instanceof OnboardingConnectionChangedError) {
    return "Your GitHub connection needs to be reconnected";
  }
  if (error instanceof OnboardingTokenChangedError) {
    return "Your GitHub connection changed; please retry";
  }
  if (error instanceof RefreshResultUnavailableError) {
    return "The refreshed score is not available yet; please retry";
  }
  return "Processing failed";
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await enforceRateLimit(request, "onboarding");
    if (!rateLimit.allowed) {
      return createRateLimitedResponse(rateLimit.retryAfterSeconds ?? 60);
    }

    const session = await readSessionCookie();
    if (!session) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(data: Record<string, unknown>) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }

        try {
          const env = await getRuntimeEnv();

          if (!env.TOKEN_ENCRYPTION_KEY) {
            sendEvent({ type: "error", message: "Server configuration error" });
            controller.close();
            return;
          }

          if (!env.REFRESH_HYPERDRIVE?.connectionString && !env.DATABASE_URL) {
            sendEvent({ type: "error", message: "Database not available" });
            controller.close();
            return;
          }
          const result = await runOnboardingRefresh(
            {
              userId: session.userId,
              targetAt: new Date().toISOString(),
              onProgress: (event) => sendEvent({ type: "progress", ...event }),
            },
            {
              repository: createRefreshRepository(env),
              decryptToken: (encrypted) =>
                decryptText(env.TOKEN_ENCRYPTION_KEY!, encrypted),
              fetchImpl: fetch,
              githubEndpoint: env.GITHUB_GRAPHQL_ENDPOINT,
              clock: () => new Date().toISOString(),
              logger: refreshLogger,
            },
          );

          sendEvent({
            type: "complete",
            rank: result.rank,
            percentile: result.percentile,
            totalCommits: result.allTimeCommits,
            login: session.login,
            name: session.name,
            avatarUrl: session.avatarUrl,
          });
        } catch (error) {
          sendEvent({ type: "error", message: onboardingErrorMessage(error) });
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return createServerErrorResponse(error);
  }
}
