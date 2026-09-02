import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { query } from "./db.ts";
import { uniqueKeys } from "./s3-hook.ts";

export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const syncTickQueue = new Queue("sync.tick", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

export const syncFileQueue = new Queue("sync.file", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

/** Quiet-window before a file-level job runs. Burst of puts → one sync.file. */
export const FILE_SYNC_DEBOUNCE_MS = 1_500;

export async function markZombieSyncRuns(): Promise<void> {
  await query(
    `UPDATE sync_run SET finished_at = now()
     WHERE finished_at IS NULL AND files_total = 0 AND started_at < now() - interval '2 minutes'`,
  );
}

export async function hasUnfinishedSyncRun(connectionId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM sync_run WHERE connection_id = $1 AND finished_at IS NULL LIMIT 1`, [connectionId]);
  return (r.rowCount ?? 0) > 0;
}

export async function enqueueSync(connectionId: string): Promise<{ queued: boolean; reason?: string; jobId: string }> {
  const jobId = "sync-" + connectionId;
  if (await hasUnfinishedSyncRun(connectionId)) {
    return { queued: false, reason: "sync_in_progress", jobId };
  }
  const existing = await syncTickQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "delayed") {
      return { queued: false, reason: "sync_in_progress", jobId };
    }
    // "active" with no unfinished sync_run is an orphan after a worker restart.
    try { await existing.remove(); } catch { /* locked by a live worker */ }
    const still = await syncTickQueue.getJob(jobId);
    if (still) {
      const stillState = await still.getState();
      if (stillState === "active" || stillState === "waiting" || stillState === "delayed") {
        return { queued: false, reason: "sync_in_progress", jobId };
      }
    }
  }
  await syncTickQueue.add("sync", { connectionId }, { jobId });
  return { queued: true, jobId };
}

/** One pending file-sync per connection so a burst of object events coalesces. */
export function syncFileJobId(connectionId: string, _keys?: string[]): string {
  return `syncfile-${connectionId}`;
}

function pendingRedisKey(connectionId: string): string {
  return `s3wake:pending:${connectionId}`;
}

async function takePendingKeys(connectionId: string, extra: string[] = []): Promise<string[]> {
  const key = pendingRedisKey(connectionId);
  if (extra.length) await redis.sadd(key, ...extra);
  const members = await redis.smembers(key);
  await redis.del(key);
  return uniqueKeys([...members, ...extra]);
}

export async function enqueueSyncFiles(
  connectionId: string,
  keys: string[],
  opts?: { debounceMs?: number },
): Promise<{ queued: boolean; reason?: string; jobId: string; keys: string[] }> {
  const incoming = uniqueKeys(keys);
  const jobId = syncFileJobId(connectionId);
  const debounceMs = opts?.debounceMs ?? FILE_SYNC_DEBOUNCE_MS;
  if (incoming.length) await redis.sadd(pendingRedisKey(connectionId), ...incoming);

  const existing = await syncFileQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "delayed" || state === "waiting") {
      const prev = Array.isArray(existing.data?.keys) ? (existing.data.keys as string[]) : [];
      const pending = await redis.smembers(pendingRedisKey(connectionId));
      const merged = uniqueKeys([...prev, ...incoming, ...pending]);
      await existing.updateData({ connectionId, keys: merged });
      if (debounceMs > 0 && typeof existing.changeDelay === "function") {
        try { await existing.changeDelay(debounceMs); } catch { /* job may have become active */ }
      }
      return { queued: true, reason: "debounced", jobId, keys: merged };
    }
    if (state === "active") {
      // Current run will finish; keep keys in Redis. A delayed follow-up picks them up.
      const followId = `${jobId}-next`;
      const follow = await syncFileQueue.getJob(followId);
      const pending = await redis.smembers(pendingRedisKey(connectionId));
      const merged = uniqueKeys([...incoming, ...pending]);
      if (follow) {
        const fs = await follow.getState();
        if (fs === "delayed" || fs === "waiting") {
          const prev = Array.isArray(follow.data?.keys) ? (follow.data.keys as string[]) : [];
          const all = uniqueKeys([...prev, ...merged]);
          await follow.updateData({ connectionId, keys: all });
          if (debounceMs > 0 && typeof follow.changeDelay === "function") {
            try { await follow.changeDelay(debounceMs); } catch { /* */ }
          }
          return { queued: true, reason: "debounced", jobId: followId, keys: all };
        }
        try { await follow.remove(); } catch { /* locked */ }
      }
      await syncFileQueue.add("sync-file", { connectionId, keys: merged }, { jobId: followId, delay: Math.max(debounceMs, 500) });
      return { queued: true, reason: "debounced", jobId: followId, keys: merged };
    }
    try { await existing.remove(); } catch { /* locked */ }
  }

  const all = await takePendingKeys(connectionId, incoming);
  await syncFileQueue.add("sync-file", { connectionId, keys: all }, { jobId, delay: debounceMs > 0 ? debounceMs : undefined });
  return { queued: true, jobId, keys: all };
}
