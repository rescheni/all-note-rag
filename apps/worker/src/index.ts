import "./load-env.ts";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { runSync } from "./sync.ts";

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

new Worker(
  "sync.tick",
  async (job) => {
    const connectionId = (job.data as { connectionId: string }).connectionId;
    console.log(JSON.stringify({ level: "info", job_id: job.id, connection_id: connectionId, message: "sync start" }));
    await runSync(connectionId);
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
    await runSync(data.connectionId, { keys: data.keys ?? [] });
  },
  { connection, concurrency: 8 },
);

console.log(JSON.stringify({ level: "info", message: "worker listening on sync.tick and sync.file" }));
