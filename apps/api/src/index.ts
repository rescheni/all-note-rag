import "./load-env.ts";
import { serve } from "@hono/node-server";
import { env } from "./env.ts";
import { app } from "./app.ts";
import { enqueueSync, markZombieSyncRuns } from "./queue.ts";
import { query } from "./db.ts";
import { TICK_MS, TICK_STALE_MS } from "./tick.ts";
import { enableLocalSourceNotifications } from "./s3-notify.ts";
import { loadAiSettings } from "@note-hub/core";
import { embedTexts } from "@note-hub/retrieve";

const port = env.apiPort;

/** 预热本地嵌入模型。
 *  ONNX 模型首次加载需要数秒；若等到第一次搜索才加载，会超出语义检索预算，
 *  导致 /search 的 similar（向量结果）恒为空。启动即加载可消除这一延迟。 */
async function warmupEmbeddings(): Promise<void> {
  try {
    const ai = await loadAiSettings(query, env.hubSecret);
    if (ai.embed_provider !== "local") return;
    const t = Date.now();
    const [emb] = await embedTexts(["预热"], {
      baseUrl: ai.base_url,
      apiKey: ai.api_key,
      model: ai.embedding_model,
      provider: ai.embed_provider,
    });
    console.log(
      JSON.stringify({
        level: "info",
        message: "embed warmup done",
        model: ai.embedding_model,
        dim: emb?.length ?? 0,
        ms: Date.now() - t,
      }),
    );
  } catch (e) {
    console.error(
      JSON.stringify({ level: "warn", message: "embed warmup failed", error: String(e) }),
    );
  }
}

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
  void warmupEmbeddings();
});

setInterval(() => {
  void enqueueActiveConnections();
}, TICK_MS).unref();
