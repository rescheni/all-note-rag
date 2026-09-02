import { connectionOwnsObject, decodeObjectKey, mapConnectionObjectKey } from "@note-hub/adapters";
import type { ConnectionRecord } from "@note-hub/core";

export type S3ObjectEvent = { bucket: string; key: string; eventName?: string };

export type MatchedFileSync = {
  connection_id: string;
  keys: string[];
};

function pushEvent(out: S3ObjectEvent[], bucket: string, key: string, eventName?: string): void {
  if (!bucket || !key) return;
  const decoded = decodeObjectKey(key);
  if (!decoded) return;
  if (out.some((e) => e.bucket === bucket && e.key === decoded)) return;
  out.push({ bucket, key: decoded, eventName });
}

function splitBucketKey(raw: string): { bucket: string; key: string } | null {
  const s = decodeObjectKey(raw);
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { bucket: s.slice(0, i), key: s.slice(i + 1) };
}

/** Parse MinIO/S3 notification JSON (Records[], {bucket,key}, or MinIO EventName/Key). */
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
      const eventName = typeof r.eventName === "string" ? r.eventName : undefined;
      pushEvent(out, bucket, key, eventName);
    }
  }
  const bucket = typeof rec.bucket === "string" ? rec.bucket : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const eventName =
    (typeof rec.eventName === "string" ? rec.eventName : undefined) ||
    (typeof rec.EventName === "string" ? rec.EventName : undefined);
  pushEvent(out, bucket, key, eventName);

  const minioKey = typeof rec.Key === "string" ? rec.Key : typeof rec.key === "string" && !bucket ? rec.key : "";
  if (minioKey && minioKey.includes("/")) {
    const split = splitBucketKey(minioKey);
    if (split) pushEvent(out, split.bucket, split.key, eventName);
  }
  return out;
}

export function uniqueKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const n = decodeObjectKey(k);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Map object events to source connections.
 * Hub canonical/preview buckets are ignored so writes we make during sync cannot loop.
 * Ignored vault paths (.obsidian, .trash, siyuan temp/) are dropped.
 */
export function matchObjectEvents(
  events: S3ObjectEvent[],
  connections: ConnectionRecord[],
): { matched: MatchedFileSync[]; ignored: S3ObjectEvent[] } {
  const grouped = new Map<string, string[]>();
  const ignored: S3ObjectEvent[] = [];
  for (const ev of events) {
    let hit = false;
    for (const conn of connections) {
      const match = connectionOwnsObject(conn, ev.bucket, ev.key);
      if (!match || match.via !== "source") continue;
      const mapped = mapConnectionObjectKey(conn, match.objectKey);
      if (!mapped || mapped.kind === "skip") continue;
      hit = true;
      const keys = grouped.get(conn.id) ?? [];
      if (!keys.includes(ev.key)) keys.push(ev.key);
      grouped.set(conn.id, keys);
    }
    if (!hit) ignored.push(ev);
  }
  const matched: MatchedFileSync[] = [...grouped.entries()].map(([connection_id, keys]) => ({
    connection_id,
    keys: uniqueKeys(keys),
  }));
  return { matched, ignored };
}
