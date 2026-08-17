import { pathToFileURL } from "node:url";

import { createRefreshRepository } from "../src/lib/refresh-repository";
import { getRuntimeEnv } from "../src/lib/runtime-env";

export function parseObservedAt(argv: readonly string[]) {
  if (argv.length !== 2 || argv[0] !== "--observed-at") {
    throw new Error("Usage: reconcile-refresh-cutover.ts --observed-at ISO_TIMESTAMP");
  }
  const value = argv[1];
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) {
    throw new Error("--observed-at must be one ISO timestamp with an offset");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("--observed-at must be one ISO timestamp with an offset");
  }
  return value;
}

export async function reconcileRefreshCutover(observedAt: string) {
  const env = await getRuntimeEnv();
  return createRefreshRepository(env).reconcileLegacyCutover(observedAt);
}

async function main() {
  const observedAt = parseObservedAt(process.argv.slice(2));
  const result = await reconcileRefreshCutover(observedAt);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    process.stderr.write("reconcile refresh cutover failed\n");
    process.exitCode = 1;
  });
}
