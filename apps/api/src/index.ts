import "./load-env.ts";
import { serve } from "@hono/node-server";
import { env } from "./env.ts";
import { app } from "./app.ts";
import { enqueueSync, markZombieSyncRuns } from "./queue.ts";
import { query } from "./db.ts";
import { TICK_MS, TICK_STALE_MS } from "./tick.ts";
import { enableLocalSourceNotifications } from "./s3-notify.ts";

const port = env.apiPort;

/** Periodic tick: only wake connections whose last sync is missing or stale.
 *  Manual POST /sync and S3 notify still enqueue immediately. */
async function enqueueActiveConnections(): Promise<void> {
  try {
    await markZombieSyncRuns();
    const r = await query<{ id: string }>(
      `SELECT id FROM connections
       WHERE status = 'active'
         AND (
           last_sync_at IS NULL
           OR last_sync_at < now() - ($1::text || ' milliseconds')::interval
         )`,
      [String(TICK_STALE_MS)],
    );
    for (const row of r.rows) await enqueueSync(row.id);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: String(e) }));
  }
}

serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ level: "info", message: `api listening on ${port}` }));
  void enableLocalSourceNotifications().catch((e) => {
    console.error(JSON.stringify({ level: "error", message: "s3 notify failed", error: String(e) }));
  });
  void enqueueActiveConnections();
});

setInterval(() => {
  void enqueueActiveConnections();
}, TICK_MS).unref();
