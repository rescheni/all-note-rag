import "./load-env.ts";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "./env.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

async function main() {
  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [f]);
    if (done.rowCount) {
      console.log("skip", f);
      continue;
    }
    const sql = readFileSync(join(dir, f), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log("applied", f);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
