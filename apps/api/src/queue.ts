import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";

export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const syncTickQueue = new Queue("sync.tick", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

export async function enqueueSync(connectionId: string): Promise<{ queued: boolean; reason?: string }> {
  const jobId = "sync-" + connectionId;
  const existing = await syncTickQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      return { queued: false, reason: "sync_in_progress" };
    }
    try { await existing.remove(); } catch { /* locked */ }
  }
  await syncTickQueue.add("sync", { connectionId }, { jobId });
  return { queued: true };
}
