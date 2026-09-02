import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ConnectionRecord } from "@note-hub/core";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { enqueueSyncFiles } from "../queue.ts";
import { extractS3Events, matchObjectEvents } from "../s3-hook.ts";

export const hookRoutes = new Hono();

export { extractS3Events, matchObjectEvents } from "../s3-hook.ts";
export type { S3ObjectEvent } from "../s3-hook.ts";

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** MinIO webhook sends auth_token as Authorization (sometimes without Bearer). */
export function readHubSecret(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const header = c.req.header("x-hub-secret") || c.req.header("X-Hub-Secret");
  if (header?.trim()) return header.trim();
  const auth = (c.req.header("authorization") ?? "").trim();
  if (!auth) return null;
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return auth;
}

hookRoutes.post("/hooks/s3", async (c) => {
  const provided = readHubSecret(c);
  if (!provided || !secretsEqual(provided, env.hubSecret)) {
    return jsonError(c, 401, "unauthenticated", "无效的 webhook 密钥");
  }
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const events = extractS3Events(body);
  if (!events.length) return jsonError(c, 400, "invalid_request", "缺少 bucket/key");

  const conns = await query("SELECT * FROM connections ORDER BY created_at DESC");
  const { matched } = matchObjectEvents(events, conns.rows as ConnectionRecord[]);
  if (!matched.length) return errors.notFound(c, "没有匹配的连接");

  const jobs: { connection_id: string; job_id: string; keys: string[] }[] = [];
  for (const m of matched) {
    const q = await enqueueSyncFiles(m.connection_id, m.keys);
    jobs.push({ connection_id: m.connection_id, job_id: q.jobId, keys: q.keys ?? m.keys });
  }
  const first = jobs[0];
  return c.json({
    ok: true,
    connection_id: first?.connection_id,
    job_id: first?.job_id,
    keys: first?.keys,
    jobs,
  });
});
