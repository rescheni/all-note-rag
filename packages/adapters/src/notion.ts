import { guessContentType, type Adapter, type AdapterContext, type Change, type NotePayload, type ProbeResult } from "@note-hub/core";
import {
  canonicalNotionId,
  flattenNotionProperties,
  notionBlocksToMarkdown,
  notionDatabaseToMarkdown,
  notionPageTitle,
  stableMarkdown,
} from "@note-hub/normalize";
import { fetchWithRetry } from "./http.ts";
import {
  applyNotionOAuthSecrets,
  notionBearerToken,
  refreshNotionAccessToken,
} from "./notion-oauth.ts";

export { notionBearerToken } from "./notion-oauth.ts";

export type NotionOAuthClient = { clientId: string; clientSecret: string };

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
/** Block types whose file object is downloaded into the hub bucket. */
const FILE_BLOCK_TYPES = new Set(["image", "file", "pdf", "video", "audio"]);
/** Skip absurd media so one 2GB video can never blow up a note ingest. */
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_PARENT_DEPTH = 100;

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `/` is the hierarchy separator. A literal slash in a Notion title is stored as fullwidth `／`. */
export function notionPathSegment(value: string, fallback = "无标题"): string {
  const clean = value.trim().replaceAll("/", "／");
  return clean || fallback;
}

function isHtmlDocument(buf: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(buf.slice(0, Math.min(buf.length, 512)))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export class NotionAdapter implements Adapter {
  private objectCache = new Map<string, Promise<Record<string, unknown> | null>>();
  private pathCache = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly oauth: NotionOAuthClient | null = null,
  ) {}

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    };
  }

  private oauthClient(): NotionOAuthClient | null {
    if (this.oauth?.clientId && this.oauth?.clientSecret) return this.oauth;
    const clientId = process.env.NOTION_CLIENT_ID ?? "";
    const clientSecret = process.env.NOTION_CLIENT_SECRET ?? "";
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  private async requestRaw(token: string, url: string, init: RequestInit = {}): Promise<Response> {
    return fetchWithRetry(this.fetchFn, url, {
      ...init,
      headers: { ...this.headers(token), ...(init.headers as Record<string, string> | undefined) },
    });
  }

  private async refreshIfPossible(ctx: AdapterContext): Promise<string | undefined> {
    const box = ctx as AdapterContext & { _notionRefreshed?: boolean };
    if (box._notionRefreshed) return undefined;
    box._notionRefreshed = true;
    const refreshToken = ctx.secrets?.refresh_token?.trim();
    const client = this.oauthClient();
    if (!refreshToken || !client) return undefined;
    try {
      const tokens = await refreshNotionAccessToken({
        refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        fetchFn: this.fetchFn,
      });
      const next = applyNotionOAuthSecrets(ctx.secrets, tokens);
      ctx.secrets = next;
      if (ctx.persistSecrets) {
        try {
          await ctx.persistSecrets(next);
        } catch {
          /* keep using in-memory token even if persist fails */
        }
      }
      return tokens.access_token;
    } catch {
      return undefined;
    }
  }

  private async request(ctx: AdapterContext, url: string, init: RequestInit = {}): Promise<Response> {
    const token = notionBearerToken(ctx.secrets);
    if (!token) return new Response("{}", { status: 401 });
    const res = await this.requestRaw(token, url, init);
    if (res.status !== 401) return res;
    const next = await this.refreshIfPossible(ctx);
    if (!next) return res;
    return this.requestRaw(next, url, init);
  }

  private async requestJson(
    ctx: AdapterContext,
    url: string,
    init: RequestInit = {},
  ): Promise<{ res: Response; json: Record<string, unknown> }> {
    const res = await this.request(ctx, url, init);
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { res, json };
  }

  private cacheObject(obj: Record<string, unknown>): void {
    const id = canonicalNotionId(String(obj.id ?? ""));
    if (id) this.objectCache.set(`${String(obj.object ?? "page")}:${id}`, Promise.resolve(obj));
  }

  private inaccessibleSegment(kind: string, id: string): string {
    const stableId = canonicalNotionId(id) || id.replaceAll("-", "");
    return `[无法访问的${kind}-${stableId.slice(0, 8) || "unknown"}]`;
  }

  private async retrieveObject(ctx: AdapterContext, id: string, kind: "page" | "database"): Promise<Record<string, unknown> | null> {
    const canonical = canonicalNotionId(id);
    if (!canonical) return null;
    const cacheKey = `${kind}:${canonical}`;
    const cached = this.objectCache.get(cacheKey);
    if (cached) return cached;
    const pending = (async () => {
      const endpoint = kind === "page" ? "pages" : "databases";
      const { res, json } = await this.requestJson(ctx, `${NOTION_API}/${endpoint}/${canonical}`);
      return res.ok ? json : null;
    })();
    this.objectCache.set(cacheKey, pending);
    return pending;
  }

  private async buildPath(ctx: AdapterContext, obj: Record<string, unknown>, seen: Set<string>, depth: number): Promise<string> {
    const id = canonicalNotionId(String(obj.id ?? ""));
    const own = notionPathSegment(notionPageTitle(obj), id ? `无标题-${id.slice(0, 8)}` : "无标题");
    if (depth >= MAX_PARENT_DEPTH) return `${this.inaccessibleSegment("父级过深", id)}/${own}`;
    if (id && seen.has(id)) return `${this.inaccessibleSegment("循环父级", id)}/${own}`;
    const nextSeen = new Set(seen);
    if (id) nextSeen.add(id);
    const parent = asDict(obj.parent);
    const type = String(parent?.type ?? "workspace");
    if (type === "workspace" || !parent) return `${notionPathSegment(ctx.connection.name || "Notion 工作区")}/${own}`;
    let parentId = "";
    let kind: "page" | "database" = "page";
    if (type === "page_id") parentId = String(parent?.page_id ?? "");
    else if (type === "database_id") { parentId = String(parent?.database_id ?? ""); kind = "database"; }
    else if (type === "data_source_id") { parentId = String(parent?.database_id ?? parent?.data_source_id ?? ""); kind = "database"; }
    else {
      const rawId = String(parent?.[type] ?? "");
      return `${this.inaccessibleSegment(type || "父级", rawId)}/${own}`;
    }
    const canonicalParent = canonicalNotionId(parentId);
    if (!canonicalParent) return `${this.inaccessibleSegment(kind === "page" ? "页面" : "数据库", parentId)}/${own}`;
    if (nextSeen.has(canonicalParent)) return `${this.inaccessibleSegment("循环父级", canonicalParent)}/${own}`;
    const parentObj = await this.retrieveObject(ctx, canonicalParent, kind);
    if (!parentObj) return `${this.inaccessibleSegment(kind === "page" ? "页面" : "数据库", canonicalParent)}/${own}`;
    return `${await this.buildPath(ctx, parentObj, nextSeen, depth + 1)}/${own}`;
  }

  /** Resolve a page/database path without fetching its body; used by sync and in-place backfill. */
  async resolvePath(ctx: AdapterContext, sourceId: string): Promise<string | null> {
    const id = canonicalNotionId(sourceId);
    if (!id) return null;
    const cached = this.pathCache.get(id);
    if (cached) return cached;
    const pending = (async () => {
      let obj = await this.retrieveObject(ctx, id, "page");
      if (!obj) obj = await this.retrieveObject(ctx, id, "database");
      if (!obj) return this.inaccessibleSegment("页面", id);
      return this.buildPath(ctx, obj, new Set(), 0);
    })();
    this.pathCache.set(id, pending);
    return pending;
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const token = notionBearerToken(ctx.secrets);
    if (!token) return { ok: false, status: "error", message: "缺少 Notion 授权" };
    try {
      const res = await this.request(ctx, `${NOTION_API}/users/me`);
      if (!res.ok) {
        return { ok: false, status: "error", message: `Notion 探活失败 (${res.status})` };
      }
      return { ok: true, status: "active" };
    } catch (err) {
      return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChanges(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const token = notionBearerToken(ctx.secrets);
    const prev = ctx.cursor ?? {};
    if (!token) return { changes: [], nextCursor: { ...prev } };
    this.objectCache.clear();
    this.pathCache.clear();

    const cursorTime = typeof prev.last_edited_time === "string" ? prev.last_edited_time : "";
    let maxSeen = cursorTime;
    const changes: Change[] = [];
    const pending: { obj: Record<string, unknown>; type: "upsert" | "delete"; id: string; edited: string }[] = [];

    const ingest = (obj: Record<string, unknown>) => {
      const id = canonicalNotionId(String(obj.id ?? ""));
      if (!id) return "ok" as const;
      this.cacheObject(obj);
      const edited = String(obj.last_edited_time ?? "");
      if (edited && (!maxSeen || edited > maxSeen)) maxSeen = edited;
      if (cursorTime && edited && edited <= cursorTime) return "older" as const;
      const archived = Boolean(obj.archived) || Boolean(obj.in_trash);
      pending.push({ obj, type: archived ? "delete" : "upsert", id, edited });
      return "ok" as const;
    };

    const search = async (value: "page" | "database") => {
      let startCursor: string | undefined;
      let hitOlder = false;
      do {
        const body: Record<string, unknown> = {
          filter: { property: "object", value },
          sort: { timestamp: "last_edited_time", direction: "descending" },
          page_size: 100,
        };
        if (startCursor) body.start_cursor = startCursor;
        const { res, json } = await this.requestJson(ctx, `${NOTION_API}/search`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          if (value === "database") return;
          throw new Error(`Notion 列表失败 (${res.status})`);
        }
        const results = Array.isArray(json.results) ? json.results : [];
        for (const item of results) {
          const obj = asDict(item);
          if (!obj) continue;
          if (ingest(obj) === "older") hitOlder = true;
        }
        startCursor = json.has_more && json.next_cursor ? String(json.next_cursor) : undefined;
        if (hitOlder) break;
      } while (startCursor);
    };

    await search("page");
    await search("database");
    for (const item of pending) {
      const path = await this.buildPath(ctx, item.obj, new Set(), 0);
      this.pathCache.set(item.id, Promise.resolve(path));
      changes.push({ type: item.type, source_id: item.id, path, source_updated_at: item.edited || undefined });
    }
    const nextCursor: Record<string, unknown> = { ...prev };
    if (maxSeen) nextCursor.last_edited_time = maxSeen;
    return { changes, nextCursor };
  }

  private async fetchChildrenNested(ctx: AdapterContext, blockId: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      let url = `${NOTION_API}/blocks/${blockId}/children?page_size=100`;
      if (cursor) url += `&start_cursor=${encodeURIComponent(cursor)}`;
      const { res, json } = await this.requestJson(ctx, url);
      if (!res.ok) break;
      const batch = Array.isArray(json.results) ? json.results : [];
      for (const item of batch) {
        const block = asDict(item);
        if (!block) continue;
        const type = String(block.type ?? "");
        const skip =
          type === "child_page" || type === "child_database" || type === "unsupported" || type === "link_to_page";
        if (block.has_children && !skip) {
          block.children = await this.fetchChildrenNested(ctx, String(block.id ?? ""));
        }
        results.push(block);
      }
      cursor = json.has_more && json.next_cursor ? String(json.next_cursor) : undefined;
    } while (cursor);
    return results;
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const token = notionBearerToken(ctx.secrets);
    if (!token) return null;
    const id = canonicalNotionId(source_id);
    const { res: pageRes, json: pageJson } = await this.requestJson(ctx, `${NOTION_API}/pages/${id}`);
    if (pageRes.ok && (pageJson.object === "page" || pageJson.properties)) {
      if (pageJson.archived || pageJson.in_trash) return null;
      const title = notionPageTitle(pageJson) || id;
      this.cacheObject(pageJson);
      const path = await this.buildPath(ctx, pageJson, new Set(), 0);
      this.pathCache.set(id, Promise.resolve(path));
      const frontmatter = flattenNotionProperties(pageJson.properties);
      const blocks = await this.fetchChildrenNested(ctx, String(pageJson.id ?? id));
      const converted = notionBlocksToMarkdown(blocks);
      const assets: NonNullable<NotePayload["assets"]> = [];
      let markdownBody = converted.markdown;
      const downloaded = await this.downloadBlockFiles(blocks);
      for (const item of downloaded) {
        assets.push({ path: item.name, bytes: item.bytes, contentType: guessContentType(item.name) });
        if (item.url) markdownBody = markdownBody.split(item.url).join(item.name);
      }
      const markdown = stableMarkdown(frontmatter, markdownBody);
      return {
        source_id: id,
        path,
        title,
        raw: markdown,
        source_updated_at: String(pageJson.last_edited_time ?? "") || undefined,
        assets,
      };
    }
    const { res: dbRes, json: dbJson } = await this.requestJson(ctx, `${NOTION_API}/databases/${id}`);
    if (dbRes.ok && (dbJson.object === "database" || dbJson.properties)) {
      const title = notionPageTitle(dbJson) || id;
      this.cacheObject(dbJson);
      const path = await this.buildPath(ctx, dbJson, new Set(), 0);
      this.pathCache.set(id, Promise.resolve(path));
      const body = notionDatabaseToMarkdown(dbJson);
      const markdown = stableMarkdown({ object: "database" }, body);
      return {
        source_id: id,
        path,
        title,
        raw: markdown,
        source_updated_at: String(dbJson.last_edited_time ?? "") || undefined,
      };
    }
    return null;
  }

  private collectFileUrls(blocks: Record<string, unknown>[]): { url: string; name: string }[] {
    const out: { url: string; name: string }[] = [];
    const walk = (list: Record<string, unknown>[]) => {
      for (const block of list) {
        const type = String(block.type ?? "");
        const data = asDict(block[type]) ?? asDict(block.image) ?? asDict(block.file);
        if (FILE_BLOCK_TYPES.has(type)) {
          const payload = asDict(block[type]) ?? {};
          let url = "";
          let name = "";
          if (payload.type === "external") {
            url = String(asDict(payload.external)?.url ?? "");
            name = String(payload.name ?? "");
          } else if (payload.type === "file") {
            url = String(asDict(payload.file)?.url ?? "");
            name = String(payload.name ?? "");
          } else {
            url = String(payload.url ?? asDict(payload.file)?.url ?? asDict(payload.external)?.url ?? "");
            name = String(payload.name ?? "");
          }
          if (url) {
            const fromUrl = url.split("?")[0].split("/").pop() || "";
            out.push({ url, name: name || fromUrl || `${type}-${out.length}` });
          }
        }
        const kids = block.children;
        if (Array.isArray(kids)) walk(kids.filter((x): x is Record<string, unknown> => Boolean(asDict(x))));
        void data;
      }
    };
    walk(blocks);
    return out;
  }

  private async downloadPublic(url: string): Promise<Uint8Array | null> {
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        this.skipAsset(url, `http ${res.status}`);
        return null;
      }
      const declared = Number(res.headers?.get?.("content-length") ?? 0);
      if (declared && declared > MAX_ASSET_BYTES) {
        this.skipAsset(url, `too large (${declared} bytes)`);
        return null;
      }
      const type = (res.headers?.get?.("content-type") ?? "").toLowerCase();
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) {
        this.skipAsset(url, "empty body");
        return null;
      }
      if (buf.byteLength > MAX_ASSET_BYTES) {
        this.skipAsset(url, `too large (${buf.byteLength} bytes)`);
        return null;
      }
      // A page (e.g. a YouTube watch url on a `video` block) is not an attachment.
      if (type.startsWith("text/html") || isHtmlDocument(buf)) {
        this.skipAsset(url, "html page, not a media file");
        return null;
      }
      return buf;
    } catch (err) {
      this.skipAsset(url, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** A failed attachment must never fail the note ingest. Log and move on. */
  private skipAsset(url: string, reason: string): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "notion asset skipped",
        reason,
        url: url.split("?")[0],
      }),
    );
  }

  private async downloadBlockFiles(blocks: Record<string, unknown>[]): Promise<{ url: string; name: string; bytes: Uint8Array }[]> {
    const out: { url: string; name: string; bytes: Uint8Array }[] = [];
    const used = new Set<string>();
    for (const item of this.collectFileUrls(blocks)) {
      const bytes = await this.downloadPublic(item.url);
      if (!bytes) continue;
      let name = item.name || `file-${out.length}`;
      if (used.has(name)) name = `${out.length}-${name}`;
      used.add(name);
      out.push({ url: item.url, name, bytes });
    }
    return out;
  }

  async fetchAsset(_ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    if (/^https?:\/\//i.test(ref)) {
      return (await this.downloadPublic(ref)) ?? new Uint8Array();
    }
    return new Uint8Array();
  }
}
