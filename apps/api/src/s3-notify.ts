import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetBucketNotificationConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  S3Client,
  type NotificationConfiguration,
} from "@aws-sdk/client-s3";
import type { ConnectionRecord } from "@note-hub/core";
import { env } from "./env.ts";
import { query } from "./db.ts";
import { enqueueSyncFiles } from "./queue.ts";
import { extractS3Events, matchObjectEvents } from "./s3-hook.ts";
import { extractJsonObjects } from "./json-stream.ts";

export const NOTEHUB_WEBHOOK_ID = "notehub";
export const NOTEHUB_QUEUE_ARN = "arn:minio:sqs::_:notehub";

export type NotifyTarget = {
  endpoint: string;
  bucket: string;
  connection_ids: string[];
  local: boolean;
  reason?: string;
};

const listening = new Set<string>();

function hostnameOf(url: string): { host: string; port: string; href: string } | null {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    const host = (u.hostname || "").toLowerCase();
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host, port, href: u.href };
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

/** True when the connection's S3 endpoint is this process's local MinIO (or loopback). */
export function isLocalS3Endpoint(endpoint: string | undefined, localEndpoint: string): boolean {
  if (!endpoint) return isLocalS3Endpoint(localEndpoint, localEndpoint);
  const a = hostnameOf(endpoint);
  const b = hostnameOf(localEndpoint);
  if (!a || !b) return false;
  if (a.host === b.host && a.port === b.port) return true;
  if (isLoopback(a.host) && isLoopback(b.host) && a.port === b.port) return true;
  return false;
}

export function sourceTargetsFromConnections(
  connections: ConnectionRecord[],
  localEndpoint: string,
  extraLocalBuckets: string[] = [],
): NotifyTarget[] {
  const byKey = new Map<string, NotifyTarget>();
  const add = (endpoint: string, bucket: string, connectionId?: string) => {
    if (!bucket) return;
    const local = isLocalS3Endpoint(endpoint, localEndpoint);
    const key = `${endpoint}::${bucket}`;
    const cur = byKey.get(key);
    if (cur) {
      if (connectionId && !cur.connection_ids.includes(connectionId)) cur.connection_ids.push(connectionId);
      return;
    }
    byKey.set(key, {
      endpoint,
      bucket,
      connection_ids: connectionId ? [connectionId] : [],
      local,
      reason: local ? undefined : "remote endpoint; poll fallback",
    });
  };
  for (const conn of connections) {
    const src = conn.source;
    if (src !== "obsidian" && src !== "siyuan") continue;
    const mode = conn.mode || conn.config?.mode;
    if (src === "siyuan" && mode && mode !== "workspace") continue;
    const bucket = conn.config?.bucket ?? "";
    const endpoint = conn.config?.endpoint || localEndpoint;
    add(endpoint, bucket, conn.id);
  }
  for (const b of extraLocalBuckets) add(localEndpoint, b);
  return [...byKey.values()];
}

function s3ClientFor(endpoint: string): S3Client {
  return new S3Client({
    region: env.s3Region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
  });
}

export function notificationHasNotehub(cfg: NotificationConfiguration | undefined): boolean {
  const queues = cfg?.QueueConfigurations ?? [];
  return queues.some((q) => q.QueueArn === NOTEHUB_QUEUE_ARN || q.Id === NOTEHUB_WEBHOOK_ID);
}

export async function ensureBucketWebhook(
  client: S3Client,
  bucket: string,
): Promise<{ ok: boolean; already: boolean; error?: string }> {
  try {
    const cur = await client.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
    if (notificationHasNotehub(cur)) return { ok: true, already: true };
    const queues = [...(cur.QueueConfigurations ?? [])];
    queues.push({
      Id: NOTEHUB_WEBHOOK_ID,
      QueueArn: NOTEHUB_QUEUE_ARN,
      Events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
    });
    await client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: queues,
          TopicConfigurations: cur.TopicConfigurations,
          LambdaFunctionConfigurations: cur.LambdaFunctionConfigurations,
        },
      }),
    );
    return { ok: true, already: false };
  } catch (e) {
    return { ok: false, already: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function findNotifyScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../scripts/minio-notify.sh"),
    path.resolve(process.cwd(), "scripts/minio-notify.sh"),
    path.resolve(process.cwd(), "../../scripts/minio-notify.sh"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function runScript(script: string, envExtra: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script], {
      env: { ...process.env, ...envExtra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** AWS SigV4 headers for a path-style MinIO GET (listenBucketNotification). */
export function signS3Get(url: URL, accessKey: string, secretKey: string, region: string, now = new Date()): Record<string, string> {
  const method = "GET";
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const host = url.host;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join("&");
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function handleListenPayload(text: string): Promise<void> {
  const chunks = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const bodies: unknown[] = [];
  if (chunks.length) {
    for (const line of chunks) {
      try {
        bodies.push(JSON.parse(line));
      } catch {
        /* ignore partial */
      }
    }
  } else if (text.trim()) {
    try {
      bodies.push(JSON.parse(text));
    } catch {
      return;
    }
  }
  if (!bodies.length) return;
  const conns = await query("SELECT * FROM connections");
  const connections = conns.rows as ConnectionRecord[];
  for (const body of bodies) {
    const events = extractS3Events(body);
    if (!events.length) continue;
    const { matched } = matchObjectEvents(events, connections);
    for (const m of matched) {
      await enqueueSyncFiles(m.connection_id, m.keys);
    }
  }
}

async function listenBucketLoop(endpoint: string, bucket: string): Promise<void> {
  const key = `${endpoint}::${bucket}`;
  if (listening.has(key)) return;
  listening.add(key);
  const events = ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"];
  let backoff = 1000;
  while (listening.has(key)) {
    try {
      const u = new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`);
      u.pathname = `/${bucket}`;
      u.search = "";
      for (const ev of events) u.searchParams.append("events", ev);
      const headers = signS3Get(u, env.s3AccessKey, env.s3SecretKey, env.s3Region);
      const res = await fetch(u, { method: "GET", headers });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => "");
        throw new Error(`listen ${bucket} ${res.status} ${msg.slice(0, 180)}`);
      }
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = extractJsonObjects(buf);
        buf = parsed.rest;
        for (const obj of parsed.objects) await handleListenPayload(JSON.stringify(obj));
      }
      if (buf.trim()) await handleListenPayload(buf);
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "s3 listen",
          bucket,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

export type NotifyEnableResult = {
  enabled: string[];
  skipped: { endpoint: string; bucket: string; reason: string }[];
  listening?: string[];
  script?: string;
};

export async function enableLocalSourceNotifications(): Promise<NotifyEnableResult> {
  const enabled: string[] = [];
  const skipped: { endpoint: string; bucket: string; reason: string }[] = [];
  const listeningBuckets: string[] = [];
  let connections: ConnectionRecord[] = [];
  try {
    const r = await query("SELECT * FROM connections");
    connections = r.rows as ConnectionRecord[];
  } catch (e) {
    return { enabled, skipped: [{ endpoint: env.s3Endpoint, bucket: "*", reason: String(e) }] };
  }

  const extra = [env.vaultBucket, "siyuan-src"].filter(Boolean);
  const targets = sourceTargetsFromConnections(connections, env.s3Endpoint, extra);
  const localBuckets = new Set<string>();
  for (const t of targets) {
    if (!t.local) {
      skipped.push({ endpoint: t.endpoint, bucket: t.bucket, reason: t.reason || "remote endpoint; poll fallback" });
      continue;
    }
    localBuckets.add(t.bucket);
  }

  const script = findNotifyScript();
  let scriptLog = "";
  if (script && localBuckets.size) {
    const ran = await runScript(script, {
      SOURCE_BUCKETS: [...localBuckets].join(","),
      HOOK_URL: `http://127.0.0.1:${env.apiPort}/v1/hooks/s3`,
    });
    scriptLog = ran.out.trim();
  }

  const client = s3ClientFor(env.s3Endpoint);
  try {
    for (const bucket of localBuckets) {
      const put = await ensureBucketWebhook(client, bucket);
      if (put.ok) enabled.push(bucket);
      else skipped.push({ endpoint: env.s3Endpoint, bucket, reason: put.error || "put notification failed" });
    }
  } finally {
    client.destroy();
  }

  for (const bucket of localBuckets) {
    void listenBucketLoop(env.s3Endpoint, bucket);
    listeningBuckets.push(bucket);
  }

  console.log(
    JSON.stringify({
      level: "info",
      message: "s3 source notify",
      enabled,
      listening: listeningBuckets,
      skipped: skipped.map((s) => ({ endpoint: s.endpoint, bucket: s.bucket, reason: s.reason })),
      script: scriptLog ? "ran" : script ? "empty" : "missing",
    }),
  );
  return { enabled, skipped, listening: listeningBuckets, script: scriptLog || undefined };
}
