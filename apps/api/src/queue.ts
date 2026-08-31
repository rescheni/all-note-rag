import { Queue } from "bullmq";
import IORedis from "ioredis";
import { sha256Hex } from "@note-hub/core";
import { env } from "./env.ts";

export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const syncTickQueue = new Queue("sync.tick", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

export const syncFileQueue = new Queue("sync.file", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

export async function enqueueSync(connectionId: string): Promise<{ queued: boolean; reason?: string; jobId: string }> {
  const jobId = "sync-" + connectionId;
  const existing = await syncTickQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      return { queued: false, reason: "sync_in_progress", jobId };
    }
    try { await existing.remove(); } catch { /* locked */ }
  }
  await syncTickQueue.add("sync", { connectionId }, { jobId });
  return { queued: true, jobId };
}

export function syncFileJobId(connectionId: string, keys: string[]): string {
  const norm = [...keys].map((k) => k.replace(/\+/g, " ")).sort().join("\0");
  const short = sha256Hex(norm).slice(0, 12);
  return `syncfile-${connectionId}-${short}`;
}

export async function enqueueSyncFiles(
  connectionId: string,
  keys: string[],
): Promise<{ queued: boolean; reason?: string; jobId: string }> {
  const jobId = syncFileJobId(connectionId, keys);
  const existing = await syncFileQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      return { queued: true, reason: "coalesced", jobId };
    }
    try { await existing.remove(); } catch { /* locked */ }
  }
  await syncFileQueue.add("sync-file", { connectionId, keys }, { jobId });
  return { queued: true, jobId };
}
