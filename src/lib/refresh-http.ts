import type { ProducerSummary } from "./refresh-contract";
import type { ProducerDependencies } from "./refresh-service";
import { runRefreshProducer } from "./refresh-service";

export type RefreshAuthorizationResult =
  | { status: 401; body: { error: "Unauthorized" } }
  | {
      status: 200;
      body: Pick<ProducerSummary, "claimed" | "enqueued" | "released">;
    };

export async function authorizeAndEnqueueRefresh(
  input: {
    authorization: string | null;
    expectedSecret: string;
    targetAt: string;
  },
  deps: ProducerDependencies,
): Promise<RefreshAuthorizationResult> {
  if (
    input.expectedSecret.length === 0 ||
    input.authorization !== `Bearer ${input.expectedSecret}`
  ) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  const summary = await runRefreshProducer(
    { source: "manual", targetAt: input.targetAt },
    deps,
  );
  return {
    status: 200,
    body: {
      claimed: summary.claimed,
      enqueued: summary.enqueued,
      released: summary.released,
    },
  };
}
