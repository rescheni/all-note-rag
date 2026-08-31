import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { connectionOwnsObject, decodeObjectKey } from "@note-hub/adapters";
import type { ConnectionRecord } from "@note-hub/core";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { enqueueSyncFiles } from "../queue.ts";

export const hookRoutes = new Hono();

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readHubSecret(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const header = c.req.header("x-hub-secret") || c.req.header("X-Hub-Secret");
  if (header?.trim()) return header.trim();
  const auth = c.req.header("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

export type S3ObjectEvent = { bucket: string; key: string; eventName?: string };

export function extractS3Events(body: unknown): S3ObjectEvent[] {
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  const out: S3ObjectEvent[] = [];
  const records = rec.Records;
  if (Array.isArray(records)) {
    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const s3 = r.s3 as Record<string, unknown> | undefined;
      const bucketObj = s3?.bucket as Record<string, unknown> | undefined;
      const objectObj = s3?.object as Record<string, unknown> | undefined;
      const bucket = typeof bucketObj?.name === "string" ? bucketObj.name : "";
      const key = typeof objectObj?.key === "string" ? objectObj.key : "";
      if (bucket && key) {
        out.push({
          bucket,
          key: decodeObjectKey(key),
          eventName: typeof r.eventName === "string" ? r.eventName : undefined,
        });
      }
    }
  }
  const bucket = typeof rec.bucket === "string" ? rec.bucket : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  if (bucket && key) {
    out.push({
      bucket,
      key: decodeObjectKey(key),
      eventName: typeof rec.eventName === "string" ? rec.eventName : undefined,
    });
  }
  return out;
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
  const jobs: { connection_id: string; job_id: string; keys: string[] }[] = [];
  const grouped = new Map<string, { conn: ConnectionRecord; keys: string[] }>();
  for (const ev of events) {
    for (const row of conns.rows) {
      const conn = row as ConnectionRecord;
      const match = connectionOwnsObject(conn, ev.bucket, ev.key, env.s3Bucket);
      if (!match) continue;
      const g = grouped.get(conn.id);
      if (g) {
        if (!g.keys.includes(ev.key)) g.keys.push(ev.key);
      } else {
        grouped.set(conn.id, { conn, keys: [ev.key] });
      }
    }
  }
  if (!grouped.size) return errors.notFound(c, "没有匹配的连接");

  for (const { conn, keys } of grouped.values()) {
    const q = await enqueueSyncFiles(conn.id, keys);
    jobs.push({ connection_id: conn.id, job_id: q.jobId, keys });
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

