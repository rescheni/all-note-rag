import "./load-env.ts";
import { serve } from "@hono/node-server";
import { env } from "./env.ts";
import { app } from "./app.ts";
import { enqueueSync } from "./queue.ts";
import { query } from "./db.ts";

const port = env.apiPort;
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ level: "info", message: `api listening on ${port}` }));
});

const TICK_MS = 5 * 60 * 1000;
setInterval(async () => {
  try {
    const r = await query<{ id: string }>(
      "SELECT id FROM connections WHERE status = 'active'",
    );
    for (const row of r.rows) await enqueueSync(row.id);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: String(e) }));
  }
}, TICK_MS).unref();
