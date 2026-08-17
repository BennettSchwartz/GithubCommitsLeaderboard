import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

for (const envFile of [".env", ".env.local"]) {
  if (fsSync.existsSync(envFile)) {
    process.loadEnvFile?.(envFile);
  }
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

const client = new Client({
  connectionString: databaseUrl,
});

await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);

    if (existing.rowCount) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
