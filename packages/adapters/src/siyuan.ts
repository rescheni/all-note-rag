import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  HubError,
  SIYUAN_OFFICIAL_S3_CODE,
  SIYUAN_OFFICIAL_S3_MESSAGE,
  posixVaultPath,
  prefixHasRepoSegment,
  sha256Hex,
  type Adapter,
  type AdapterContext,
  type Change,
  type NotePayload,
  type ProbeResult,
} from "@note-hub/core";

export type StoredObject = { key: string; etag?: string; body?: string | Uint8Array };

export type ObjectStore = {
  list(prefix: string): Promise<{ key: string; etag?: string }[]>;
  get(key: string): Promise<Uint8Array | null>;
};

export function memoryStore(files: Record<string, string | Uint8Array>): ObjectStore {
  const etagOf = (key: string, body: string | Uint8Array) =>
    sha256Hex(typeof body === "string" ? body : body).slice(0, 16);
  return {
    async list(prefix: string) {
      const pfx = posixVaultPath(prefix).replace(/\/+$/, "");
      return Object.entries(files)
        .filter(([k]) => {
          const key = posixVaultPath(k);
          if (!pfx) return true;
          return key === pfx || key.startsWith(pfx + "/");
        })
        .map(([k, body]) => ({ key: posixVaultPath(k), etag: etagOf(k, body) }));
    },
    async get(key: string) {
      const body = files[key] ?? files[posixVaultPath(key)];
      if (body == null) return null;
      return typeof body === "string" ? new TextEncoder().encode(body) : body;
    },
  };
}

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return new Uint8Array(body);
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof b.transformToByteArray === "function") return b.transformToByteArray();
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function createS3Client(ctx: AdapterContext, injected?: S3Client): S3Client {
  if (injected) return injected;
  const cfg = ctx.connection.config;
  const secrets = ctx.secrets;
  return new S3Client({
    region: cfg.region || "us-east-1",
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.force_path_style !== false,
    credentials:
      secrets?.access_key && secrets?.secret_key
        ? { accessKeyId: secrets.access_key, secretAccessKey: secrets.secret_key }
        : undefined,
  });
}

function s3Store(ctx: AdapterContext, client: S3Client): ObjectStore {
  const bucket = ctx.connection.config.bucket ?? "";
  return {
    async list(prefix: string) {
      const out: { key: string; etag?: string }[] = [];
      let token: string | undefined;
      const pfx = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;
      do {
        const resp = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: pfx || undefined,
            ContinuationToken: token,
          }),
        );
        for (const obj of resp.Contents ?? []) {
          if (!obj.Key) continue;
          out.push({ key: obj.Key, etag: (obj.ETag ?? "").replaceAll('"', "") });
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key: string) {
      try {
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return streamToBytes(resp.Body);
      } catch {
        return null;
      }
    },
  };
}

function modeOf(ctx: AdapterContext): "api" | "workspace" {
  const m = ctx.connection.mode || ctx.connection.config.mode || "api";
  return m === "workspace" ? "workspace" : "api";
}

function workspacePrefix(ctx: AdapterContext): string {
  return posixVaultPath(ctx.connection.config.workspace_prefix ?? "").replace(/\/+$/, "");
}

function looksLikeOfficialRepo(keys: string[], prefix: string): boolean {
  if (prefixHasRepoSegment(prefix) || prefix === "repo" || prefix.endsWith("/repo")) return true;
  const rels = keys.map((k) => {
    const p = posixVaultPath(k);
    if (prefix && (p === prefix || p.startsWith(prefix + "/"))) return p.slice(prefix.length).replace(/^\/+/, "");
    return p;
  });
  const hasSy = rels.some((k) => k.endsWith(".sy"));
  const hasRepo = rels.some((k) => k.split("/").includes("repo"));
  return hasRepo && !hasSy;
}

function officialFailProbe(): ProbeResult {
  return {
    ok: false,
    status: "error",
    code: SIYUAN_OFFICIAL_S3_CODE,
    message: SIYUAN_OFFICIAL_S3_MESSAGE,
  };
}

function officialThrow(): never {
  throw new HubError(SIYUAN_OFFICIAL_S3_CODE, SIYUAN_OFFICIAL_S3_MESSAGE, 400);
}

const BOX_RE = /^(\d{14}-[0-9a-z]+)$/i;

function kernelBase(ctx: AdapterContext): string {
  return (ctx.connection.config.kernel_base_url || "http://127.0.0.1:6806").replace(/\/+$/, "");
}

export class SiYuanAdapter implements Adapter {
  constructor(
    private readonly opts: {
      store?: ObjectStore;
      fetch?: typeof fetch;
      s3?: S3Client;
    } = {},
  ) {}

  private fetchFn(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private storeFor(ctx: AdapterContext): ObjectStore {
    if (this.opts.store) return this.opts.store;
    return s3Store(ctx, createS3Client(ctx, this.opts.s3));
  }

  private async kernel(
    ctx: AdapterContext,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = ctx.secrets?.token;
    if (token) headers.authorization = token.startsWith("Token ") ? token : `Token ${token}`;
    const res = await this.fetchFn()(`${kernelBase(ctx)}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { ok: res.ok, status: res.status, json };
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const cfg = ctx.connection.config;
    if (cfg.official_s3 || prefixHasRepoSegment(cfg.workspace_prefix) || prefixHasRepoSegment(cfg.remote_prefix)) {
      return officialFailProbe();
    }
    if (modeOf(ctx) === "api") {
      try {
        const r = await this.kernel(ctx, "/api/notebook/lsNotebooks", {});
        if (!r.ok || Number(r.json.code ?? 0) !== 0) {
          return {
            ok: false,
            status: "error",
            message: String(r.json.msg ?? r.json.message ?? `思源内核探活失败 (${r.status})`),
          };
        }
        return { ok: true, status: "active" };
      } catch (err) {
        return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      if (!this.opts.store) {
        await createS3Client(ctx, this.opts.s3).send(
          new HeadBucketCommand({ Bucket: cfg.bucket ?? "" }),
        );
      }
      const prefix = workspacePrefix(ctx);
      const listed = await this.storeFor(ctx).list(prefix);
      if (looksLikeOfficialRepo(listed.map((x) => x.key), prefix)) return officialFailProbe();
      return { ok: true, status: "active" };
    } catch (err) {
      return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChanges(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    if (
      ctx.connection.config.official_s3 ||
      prefixHasRepoSegment(ctx.connection.config.workspace_prefix) ||
      prefixHasRepoSegment(ctx.connection.config.remote_prefix)
    ) {
      officialThrow();
    }
    if (modeOf(ctx) === "api") return this.listChangesApi(ctx);
    return this.listChangesWorkspace(ctx);
  }

  private async listChangesApi(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const nbs = ctx.connection.config.notebook_ids ?? [];
    let stmt = "SELECT id, box, path, hpath, content, updated FROM blocks WHERE type = 'd'";
    if (nbs.length) {
      const inList = nbs.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      stmt += ` AND box IN (${inList})`;
    }
    const r = await this.kernel(ctx, "/api/query/sql", { stmt });
    if (!r.ok || Number(r.json.code ?? 0) !== 0) {
      throw new Error(String(r.json.msg ?? `思源 SQL 失败 (${r.status})`));
    }
    const rows = Array.isArray(r.json.data) ? r.json.data : [];
    const prev = ((ctx.cursor ?? {}) as { etags?: Record<string, string> }).etags ?? {};
    const current: Record<string, string> = {};
    const changes: Change[] = [];
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      const id = String(rec.id ?? "");
      if (!id) continue;
      const etag = String(rec.updated ?? rec.content ?? id);
      current[id] = etag;
      if (prev[id] && prev[id] === etag) continue;
      changes.push({
        type: "upsert",
        source_id: id,
        path: String(rec.hpath ?? rec.path ?? id),
        etag,
        source_updated_at: typeof rec.updated === "string" ? rec.updated : undefined,
      });
    }
    for (const id of Object.keys(prev)) {
      if (!current[id]) changes.push({ type: "delete", source_id: id });
    }
    return { changes, nextCursor: { etags: current } };
  }

  private async listChangesWorkspace(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const prefix = workspacePrefix(ctx);
    const store = this.storeFor(ctx);
    const listed = await store.list(prefix);
    if (looksLikeOfficialRepo(listed.map((x) => x.key), prefix)) officialThrow();

    const relOf = (key: string) => {
      const k = posixVaultPath(key);
      if (!prefix) return k;
      if (k === prefix) return "";
      if (k.startsWith(prefix + "/")) return k.slice(prefix.length + 1);
      return k;
    };

    const encryptedBoxes = new Set<string>();
    const confByBox = new Map<string, Record<string, unknown>>();
    for (const obj of listed) {
      const rel = relOf(obj.key);
      const m = /^data\/([^/]+)\/\.siyuan\/conf\.json$/.exec(rel);
      if (!m) continue;
      const raw = await store.get(obj.key);
      if (!raw) continue;
      try {
        const conf = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        confByBox.set(m[1], conf);
        if (conf.encrypted === true || conf.encrypted === "true") encryptedBoxes.add(m[1]);
      } catch {
        encryptedBoxes.add(m[1]);
      }
    }

    const prev = ((ctx.cursor ?? {}) as { etags?: Record<string, string> }).etags ?? {};
    const current: Record<string, { etag: string; key: string; path: string }> = {};

    for (const obj of listed) {
      const rel = relOf(obj.key);
      if (!rel || rel.endsWith("/")) continue;
      if (rel.startsWith("temp/") || rel.includes("/temp/")) continue;
      if (!rel.endsWith(".sy")) continue;
      // data/<boxID>/.../<docID>.sy
      const parts = rel.split("/");
      const dataIdx = parts.indexOf("data");
      if (dataIdx < 0 || parts.length < dataIdx + 3) continue;
      const boxId = parts[dataIdx + 1];
      if (!BOX_RE.test(boxId)) continue;
      if (parts[dataIdx + 2] === "assets") continue;
      if (encryptedBoxes.has(boxId)) continue;
      const file = parts[parts.length - 1];
      const sourceId = file.replace(/\.sy$/i, "");
      const bytes = await store.get(obj.key);
      if (!bytes) continue;
      const text = new TextDecoder().decode(bytes);
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      try {
        JSON.parse(text);
      } catch {
        continue;
      }
      const etag = obj.etag || sha256Hex(bytes).slice(0, 16);
      current[sourceId] = { etag, key: obj.key, path: rel };
    }

    const changes: Change[] = [];
    for (const [id, v] of Object.entries(current)) {
      if (prev[id] && prev[id] === v.etag) continue;
      changes.push({ type: "upsert", source_id: id, path: v.path, etag: v.etag });
    }
    for (const id of Object.keys(prev)) {
      if (!current[id]) changes.push({ type: "delete", source_id: id });
    }
    const nextEtags: Record<string, string> = {};
    for (const [id, v] of Object.entries(current)) nextEtags[id] = v.etag;
    void confByBox;
    return { changes, nextCursor: { etags: nextEtags, keys: Object.fromEntries(Object.entries(current).map(([id, v]) => [id, v.key])) } };
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    if (modeOf(ctx) === "api") {
      const r = await this.kernel(ctx, "/api/export/exportMdContent", { id: source_id });
      if (!r.ok || Number(r.json.code ?? 0) !== 0) return null;
      const data = (r.json.data ?? {}) as Record<string, unknown>;
      const content = String(data.content ?? data.md ?? "");
      const hPath = String(data.hPath ?? data.hpath ?? source_id);
      const title = String(data.name ?? data.title ?? hPath.split("/").filter(Boolean).pop() ?? source_id);
      return { source_id, path: hPath, title, raw: content };
    }
    const prefix = workspacePrefix(ctx);
    const store = this.storeFor(ctx);
    const listed = await store.list(prefix);
    const needle = `${source_id}.sy`;
    const hit = listed.find((o) => o.key.endsWith("/" + needle) || o.key === needle || posixVaultPath(o.key).endsWith("/" + needle));
    if (!hit) return null;
    const bytes = await store.get(hit.key);
    if (!bytes) return null;
    const raw = new TextDecoder().decode(bytes);
    let title = source_id;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const props = (parsed.Properties ?? parsed.properties ?? {}) as Record<string, unknown>;
      if (typeof props.title === "string" && props.title) title = props.title;
    } catch {
      return null;
    }
    const rel = (() => {
      const k = posixVaultPath(hit.key);
      if (prefix && k.startsWith(prefix + "/")) return k.slice(prefix.length + 1);
      return k;
    })();
    return { source_id, path: rel, title, raw };
  }

  async fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    if (modeOf(ctx) === "api") return new Uint8Array();
    const prefix = workspacePrefix(ctx);
    const key = prefix ? `${prefix}/${posixVaultPath(ref)}` : posixVaultPath(ref);
    const bytes = await this.storeFor(ctx).get(key);
    return bytes ?? new Uint8Array();
  }
}
