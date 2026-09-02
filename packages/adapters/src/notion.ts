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

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class NotionAdapter implements Adapter {
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

    const cursorTime = typeof prev.last_edited_time === "string" ? prev.last_edited_time : "";
    let maxSeen = cursorTime;
    const changes: Change[] = [];

    const ingest = (obj: Record<string, unknown>) => {
      const id = canonicalNotionId(String(obj.id ?? ""));
      if (!id) return "ok" as const;
      const edited = String(obj.last_edited_time ?? "");
      if (edited && (!maxSeen || edited > maxSeen)) maxSeen = edited;
      if (cursorTime && edited && edited <= cursorTime) return "older" as const;
      const title = notionPageTitle(obj) || id;
      const archived = Boolean(obj.archived) || Boolean(obj.in_trash);
      if (archived) {
        changes.push({
          type: "delete",
          source_id: id,
          path: title,
          source_updated_at: edited || undefined,
        });
        return "ok" as const;
      }
      changes.push({
        type: "upsert",
        source_id: id,
        path: title,
        source_updated_at: edited || undefined,
      });
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
        path: title || id,
        title,
        raw: markdown,
        source_updated_at: String(pageJson.last_edited_time ?? "") || undefined,
        assets,
      };
    }
    const { res: dbRes, json: dbJson } = await this.requestJson(ctx, `${NOTION_API}/databases/${id}`);
    if (dbRes.ok && (dbJson.object === "database" || dbJson.properties)) {
      const title = notionPageTitle(dbJson) || id;
      const body = notionDatabaseToMarkdown(dbJson);
      const markdown = stableMarkdown({ object: "database" }, body);
      return {
        source_id: id,
        path: title || id,
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
        if (type === "image" || type === "file" || type === "pdf") {
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
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.byteLength ? buf : null;
    } catch {
      return null;
    }
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
