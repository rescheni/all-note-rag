import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.ts";
import { query } from "./db.ts";

export const EXTRACT_QUEUE_NAME = "extract.asset";
export const EXTRACT_JOB_ID = "extract-drain";

let connection: IORedis | null = null;
let queue: Queue | null = null;

export function initExtractQueue(conn: IORedis): void {
  connection = conn;
  queue = new Queue(EXTRACT_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: { removeOnComplete: 20, removeOnFail: 50 },
  });
}

function getConnection(): IORedis {
  if (!connection) connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  return connection;
}

export function getExtractQueue(): Queue {
  if (!queue) {
    queue = new Queue(EXTRACT_QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: { removeOnComplete: 20, removeOnFail: 50 },
    });
  }
  return queue;
}

/** Enqueue a drain job if pending rows remain and none is already queued/active. */
export async function kickExtractDrain(): Promise<boolean> {
  const pending = await query<{ n: string }>(
    "SELECT 1 AS n FROM assets WHERE extract_status = 'pending' LIMIT 1",
  );
  if (!pending.rows[0]) return false;
  const q = getExtractQueue();
  const existing = await q.getJob(EXTRACT_JOB_ID);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "delayed" || state === "active") return false;
    try {
      await existing.remove();
    } catch {
      return false;
    }
  }
  await q.add("drain", {}, { jobId: EXTRACT_JOB_ID });
  return true;
}
