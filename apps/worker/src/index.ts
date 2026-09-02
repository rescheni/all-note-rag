import "./load-env.ts";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { finishAllUnfinishedSyncRuns, markZombieSyncRuns, runSync } from "./sync.ts";
import { drainExtractBatch, recoverStaleExtracts } from "./extract-drain.ts";
import { EXTRACT_QUEUE_NAME, initExtractQueue, kickExtractDrain } from "./extract-queue.ts";

await markZombieSyncRuns();
await finishAllUnfinishedSyncRuns();
await recoverStaleExtracts();

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
initExtractQueue(connection);

new Worker(
  "sync.tick",
  async (job) => {
    const connectionId = (job.data as { connectionId: string }).connectionId;
    console.log(JSON.stringify({ level: "info", job_id: job.id, connection_id: connectionId, message: "sync start" }));
    try {
      await runSync(connectionId);
    } finally {
      void kickExtractDrain();
    }
  },
  { connection, concurrency: 4 },
);

new Worker(
  "sync.file",
  async (job) => {
    const data = job.data as { connectionId: string; keys: string[] };
    console.log(
      JSON.stringify({
        level: "info",
        job_id: job.id,
        connection_id: data.connectionId,
        keys: data.keys?.length ?? 0,
        message: "file sync start",
      }),
    );
    try {
      await runSync(data.connectionId, { keys: data.keys ?? [] });
    } finally {
      void kickExtractDrain();
    }
  },
  { connection, concurrency: 8 },
);

const extractWorker = new Worker(
  EXTRACT_QUEUE_NAME,
  async () => drainExtractBatch(),
  { connection, concurrency: 1 },
);
extractWorker.on("completed", (_job, result: { pendingLeft?: number }) => {
  if ((result?.pendingLeft ?? 0) > 0) void kickExtractDrain();
});
extractWorker.on("failed", (job, err) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "extract drain failed",
      job_id: job?.id ?? null,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  void kickExtractDrain();
});

void kickExtractDrain();

console.log(JSON.stringify({ level: "info", message: "worker listening on sync.tick, sync.file, extract.asset" }));
