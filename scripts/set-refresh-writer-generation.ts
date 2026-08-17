import process from "node:process";

import { Client } from "pg";

import { switchRefreshWriterGeneration } from "../src/lib/postgres";

type WriterGeneration = "legacy" | "queue_v1";

function readFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1]?.startsWith("--")) {
    throw new Error(`${name} requires legacy or queue_v1`);
  }
  if (process.argv.indexOf(name, index + 1) >= 0) {
    throw new Error(`${name} may be supplied only once`);
  }
  return process.argv[index + 1];
}

function parseGeneration(value: string | undefined, flag: string): WriterGeneration {
  if (value !== "legacy" && value !== "queue_v1") {
    throw new Error(`${flag} requires legacy or queue_v1`);
  }
  return value;
}

async function main() {
  const allowed = new Set(["--from", "--to"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!allowed.has(process.argv[index] ?? "")) {
      throw new Error(`unknown argument: ${process.argv[index]}`);
    }
  }
  const from = parseGeneration(readFlag("--from"), "--from");
  const to = parseGeneration(readFlag("--to"), "--to");
  if (from === to) throw new Error("--from and --to must differ");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await switchRefreshWriterGeneration(client, from, to);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "writer generation switch failed"}\n`);
  process.exitCode = 1;
});
