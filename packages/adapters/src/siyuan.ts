import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  collectAssetRefs,
  guessContentType,
  isHubError,
  posixVaultPath,
  prefixHasRepoSegment,
  sha256Hex,
  type Adapter,
  type AdapterContext,
  type Change,
  type NotePayload,
  type ProbeResult,
} from "@note-hub/core";
import {
  detectOfficialRepo,
  fetchOfficialAsset,
  fetchOfficialNote,
  isOfficialCursor,
  listOfficialChanges,
  probeOfficialRepo,
  repoPasswordFromSecrets,
  rewriteBoxPath,
  classifyRepoFilePath,
  type OfficialCursor,
} from "./siyuan-dejavu.ts";

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

function flaggedOfficial(ctx: AdapterContext): boolean {
  const cfg = ctx.connection.config;
  return Boolean(cfg.official_s3) || prefixHasRepoSegment(cfg.workspace_prefix) || prefixHasRepoSegment(cfg.remote_prefix);
}

function hubFromUnknown(err: unknown): ProbeResult {
  if (isHubError(err)) {
    return { ok: false, status: "error", code: err.code, message: err.message };
  }
  return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
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

  /** Fresh snapshot file map from the latest listChanges (worker fetchNote still has the old cursor). */
  private lastOfficial: OfficialCursor | null = null;

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

  private async kernelFile(ctx: AdapterContext, filePath: string): Promise<Uint8Array> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = ctx.secrets?.token;
    if (token) headers.authorization = token.startsWith("Token ") ? token : `Token ${token}`;
    const res = await this.fetchFn()(`${kernelBase(ctx)}/api/file/getFile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) return new Uint8Array();
    const buf = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder().decode(buf.slice(0, Math.min(buf.length, 80))).trim();
    if (head.startsWith("{")) {
      try {
        const json = JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
        if (Number(json.code ?? 0) !== 0) return new Uint8Array();
      } catch {
        /* binary */
      }
    }
    return buf;
  }

  private async officialWorkspace(
    ctx: AdapterContext,
    store: ObjectStore,
    listed?: { key: string }[],
  ): Promise<boolean> {
    if (flaggedOfficial(ctx)) return true;
    if (isOfficialCursor(ctx.cursor)) return true;
    const prefix = workspacePrefix(ctx);
    const keys = listed ?? (await store.list(prefix));
    return detectOfficialRepo(store, keys, prefix);
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
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
          new HeadBucketCommand({ Bucket: ctx.connection.config.bucket ?? "" }),
        );
      }
      const prefix = workspacePrefix(ctx);
      const store = this.storeFor(ctx);
      const listed = await store.list(prefix);
      if (await this.officialWorkspace(ctx, store, listed)) {
        await probeOfficialRepo(store, ctx.secrets, prefix);
      }
      return { ok: true, status: "active" };
    } catch (err) {
      return hubFromUnknown(err);
    }
  }

  async listChanges(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
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
    const boxes: Record<string, string> = {};
    const changes: Change[] = [];
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      const id = String(rec.id ?? "");
      if (!id) continue;
      const etag = String(rec.updated ?? rec.content ?? id);
      current[id] = etag;
      if (typeof rec.box === "string" && rec.box) boxes[id] = rec.box;
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
      if (id.startsWith("asset:")) continue;
      if (!current[id]) changes.push({ type: "delete", source_id: id });
    }
    const boxNames: Record<string, string> = {};
    try {
      const nbs = await this.kernel(ctx, "/api/notebook/lsNotebooks", {});
      const data = nbs.json.data as { notebooks?: { id?: unknown; name?: unknown }[] } | { id?: unknown; name?: unknown }[] | undefined;
      const list = Array.isArray(data) ? data : data && typeof data === "object" ? data.notebooks ?? [] : [];
      for (const nb of list ?? []) {
        const id = typeof nb?.id === "string" ? nb.id : "";
        const name = typeof nb?.name === "string" ? nb.name.trim() : "";
        if (id && name) boxNames[id] = name;
      }
    } catch {
      /* names are optional */
    }
    return { changes, nextCursor: { etags: current, boxes, boxNames } };
  }

  private async listChangesWorkspace(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const prefix = workspacePrefix(ctx);
    const store = this.storeFor(ctx);
    const listed = await store.list(prefix);
    if (await this.officialWorkspace(ctx, store, listed)) {
      const prev = ((ctx.cursor ?? {}) as { etags?: Record<string, string> }).etags ?? {};
      const result = await listOfficialChanges(store, ctx.secrets, prefix, prev);
      this.lastOfficial = result.nextCursor;
      return result;
    }

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
    const boxNames: Record<string, string> = {};
    for (const [id, conf] of confByBox) {
      if (typeof conf.name === "string" && conf.name.trim()) boxNames[id] = conf.name.trim();
    }

    for (const obj of listed) {
      const rel = relOf(obj.key);
      if (!rel || rel.endsWith("/")) continue;
      if (rel.startsWith("temp/") || rel.includes("/temp/")) continue;
      const parts = rel.split("/");
      const dataIdx = parts.indexOf("data");
      if (dataIdx < 0 || parts.length < dataIdx + 3) continue;
      const boxId = parts[dataIdx + 1];
      if (!BOX_RE.test(boxId)) continue;
      if (encryptedBoxes.has(boxId)) continue;
      const afterBox = parts[dataIdx + 2];
      const file = parts[parts.length - 1];
      const display = rewriteBoxPath(rel, boxId, boxNames[boxId]);
      if (afterBox === "assets") {
        const relAsset = parts.slice(dataIdx + 2).join("/");
        const sourceId = `asset:${boxId}:${relAsset}`;
        const etag = obj.etag || "";
        current[sourceId] = { etag: etag || obj.key, key: obj.key, path: display };
        continue;
      }
      if (!rel.endsWith(".sy")) continue;
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
      current[sourceId] = { etag, key: obj.key, path: display };
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
    void classifyRepoFilePath;
    return { changes, nextCursor: { etags: nextEtags, keys: Object.fromEntries(Object.entries(current).map(([id, v]) => [id, v.key])), boxNames } };
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    if (modeOf(ctx) === "api") {
      if (source_id.startsWith("asset:")) {
        const bytes = await this.fetchAsset(ctx, source_id.slice("asset:".length));
        const name = posixVaultPath(source_id).split("/").pop() || source_id;
        if (!bytes.byteLength) return null;
        return { source_id, path: name, title: name, raw: "", kind: "asset", assets: [{ path: name, bytes, contentType: guessContentType(name) }] };
      }
      const r = await this.kernel(ctx, "/api/export/exportMdContent", { id: source_id });
      if (!r.ok || Number(r.json.code ?? 0) !== 0) return null;
      const data = (r.json.data ?? {}) as Record<string, unknown>;
      const content = String(data.content ?? data.md ?? "");
      const hPath = String(data.hPath ?? data.hpath ?? source_id);
      const title = String(data.name ?? data.title ?? hPath.split("/").filter(Boolean).pop() ?? source_id);
      const box = String(((ctx.cursor ?? {}) as { boxes?: Record<string, string> }).boxes?.[source_id] ?? "");
      const assets: NotePayload["assets"] = [];
      for (const ref of collectAssetRefs(content)) {
        const candidates = [ref, box ? `data/${box}/${ref}` : "", box ? `/data/${box}/${ref}` : ""].filter(Boolean);
        for (const c of candidates) {
          const bytes = await this.kernelFile(ctx, c.startsWith("/") ? c : `/${c}`);
          if (bytes.byteLength) {
            assets.push({ path: ref, bytes, contentType: guessContentType(ref) });
            break;
          }
        }
      }
      return { source_id, path: hPath, title, raw: content, assets };
    }
    const prefix = workspacePrefix(ctx);
    const store = this.storeFor(ctx);
    if (
      this.lastOfficial ||
      isOfficialCursor(ctx.cursor) ||
      flaggedOfficial(ctx) ||
      repoPasswordFromSecrets(ctx.secrets)
    ) {
      const official =
        Boolean(this.lastOfficial) ||
        isOfficialCursor(ctx.cursor) ||
        flaggedOfficial(ctx) ||
        (await this.officialWorkspace(ctx, store));
      if (official) {
        return fetchOfficialNote(
          store,
          ctx.secrets,
          prefix,
          source_id,
          this.lastOfficial ?? (ctx.cursor as OfficialCursor),
        );
      }
    }
    const payloadFromKey = async (key: string): Promise<NotePayload | null> => {
      const bytes = await store.get(key);
      if (!bytes) return null;
      const k = posixVaultPath(key);
      const rel = prefix && k.startsWith(prefix + "/") ? k.slice(prefix.length + 1) : k;
      if (source_id.startsWith("asset:") || "/"+rel+"/".includes("/assets/")) {
        const name = rel.split("/").pop() || source_id;
        return { source_id, path: rel, title: name, raw: "", kind: "asset", assets: [{ path: name, bytes, contentType: guessContentType(name) }] };
      }
      const raw = new TextDecoder().decode(bytes);
      let title = source_id;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const props = (parsed.Properties ?? parsed.properties ?? {}) as Record<string, unknown>;
        if (typeof props.title === "string" && props.title) title = props.title;
      } catch {
        return null;
      }
      const assets: NotePayload["assets"] = [];
      for (const ref of collectAssetRefs(raw)) {
        const parts = rel.split("/");
        const dataIdx = parts.indexOf("data");
        const boxId = dataIdx >= 0 ? parts[dataIdx + 1] : parts[0];
        const assetRel = posixVaultPath(ref).startsWith("data/") ? posixVaultPath(ref) : `data/${boxId}/${posixVaultPath(ref)}`;
        const assetKey = prefix ? `${prefix}/${assetRel}` : assetRel;
        const ab = await store.get(assetKey);
        if (ab?.byteLength) assets.push({ path: posixVaultPath(ref), bytes: ab, contentType: guessContentType(ref) });
      }
      return { source_id, path: rel, title, raw, assets };
    };
    if (ctx.objectKey) {
      const hit = await payloadFromKey(ctx.objectKey);
      if (hit) return hit;
    }
    const keysMap = (ctx.cursor as { keys?: Record<string, string> } | null)?.keys;
    if (keysMap?.[source_id]) {
      const hit = await payloadFromKey(keysMap[source_id]);
      if (hit) return hit;
    }
    const listed = await store.list(prefix);
    const needle = `${source_id}.sy`;
    const listedHit = listed.find((o) => o.key.endsWith("/" + needle) || o.key === needle || posixVaultPath(o.key).endsWith("/" + needle));
    if (!listedHit) return null;
    return payloadFromKey(listedHit.key);
  }

  async fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    const rel = posixVaultPath(ref.replace(/^asset:[^:]+:/, ""));
    if (modeOf(ctx) === "api") {
      const candidates = [rel, rel.startsWith("/") ? rel : `/${rel}`, rel.startsWith("data/") ? rel : `data/${rel}`];
      for (const c of candidates) {
        const bytes = await this.kernelFile(ctx, c.startsWith("/") ? c : `/${c}`);
        if (bytes.byteLength) return bytes;
      }
      return new Uint8Array();
    }
    const prefix = workspacePrefix(ctx);
    const store = this.storeFor(ctx);
    if (
      this.lastOfficial ||
      isOfficialCursor(ctx.cursor) ||
      flaggedOfficial(ctx) ||
      repoPasswordFromSecrets(ctx.secrets)
    ) {
      try {
        const bytes = await fetchOfficialAsset(
          store,
          ctx.secrets,
          prefix,
          rel,
          this.lastOfficial ?? (ctx.cursor as OfficialCursor),
        );
        if (bytes.byteLength) return bytes;
      } catch {
        /* fall through to plaintext key */
      }
    }
    const key = prefix ? `${prefix}/${rel}` : rel;
    const bytes = await store.get(key);
    if (bytes) return bytes;
    if (!rel.startsWith("data/")) {
      const alt = await store.get(prefix ? `${prefix}/data/${rel}` : `data/${rel}`);
      if (alt) return alt;
    }
    return new Uint8Array();
  }
}
