import "./load-env.ts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { env } from "./env.ts";
import { app } from "./app.ts";
import { enqueueSync } from "./queue.ts";
import { query } from "./db.ts";
import { TICK_MS } from "./tick.ts";

const port = env.apiPort;

function spawnMinioNotify(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../../scripts/minio-notify.sh"),
      path.resolve(process.cwd(), "scripts/minio-notify.sh"),
      path.resolve(process.cwd(), "../../scripts/minio-notify.sh"),
    ];
    const script = candidates.find((p) => existsSync(p));
    if (!script) return;
    const child = spawn("bash", [script], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* best-effort; never block listen */
  }
}

async function enqueueActiveConnections(): Promise<void> {
  try {
    const r = await query<{ id: string }>(
      "SELECT id FROM connections WHERE status = 'active'",
    );
    for (const row of r.rows) await enqueueSync(row.id);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: String(e) }));
  }
}

serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ level: "info", message: `api listening on ${port}` }));
  spawnMinioNotify();
  void enqueueActiveConnections();
});

setInterval(() => {
  void enqueueActiveConnections();
}, TICK_MS).unref();
