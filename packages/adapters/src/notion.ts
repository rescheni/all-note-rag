import type { Adapter, AdapterContext, Change, NotePayload, ProbeResult } from "@note-hub/core";
import {
  canonicalNotionId,
  flattenNotionProperties,
  notionBlocksToMarkdown,
  notionDatabaseToMarkdown,
  notionPageTitle,
  stableMarkdown,
} from "@note-hub/normalize";
import { fetchWithRetry } from "./http.ts";

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class NotionAdapter implements Adapter {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    };
  }

  private async request(token: string, url: string, init: RequestInit = {}): Promise<Response> {
    return fetchWithRetry(this.fetchFn, url, {
      ...init,
      headers: { ...this.headers(token), ...(init.headers as Record<string, string> | undefined) },
    });
  }

  private async requestJson(
    token: string,
    url: string,
    init: RequestInit = {},
  ): Promise<{ res: Response; json: Record<string, unknown> }> {
    const res = await this.request(token, url, init);
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { res, json };
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const token = ctx.secrets?.token;
    if (!token) return { ok: false, status: "error", message: "缺少 Notion token" };
    try {
      const res = await this.fetchFn("https://api.notion.com/v1/users/me", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      });
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
    const token = ctx.secrets?.token;
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
        const { res, json } = await this.requestJson(token, `${NOTION_API}/search`, {
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

  private async fetchChildrenNested(token: string, blockId: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      let url = `${NOTION_API}/blocks/${blockId}/children?page_size=100`;
      if (cursor) url += `&start_cursor=${encodeURIComponent(cursor)}`;
      const { res, json } = await this.requestJson(token, url);
      if (!res.ok) break;
      const batch = Array.isArray(json.results) ? json.results : [];
      for (const item of batch) {
        const block = asDict(item);
        if (!block) continue;
        const type = String(block.type ?? "");
        const skip =
          type === "child_page" || type === "child_database" || type === "unsupported" || type === "link_to_page";
        if (block.has_children && !skip) {
          block.children = await this.fetchChildrenNested(token, String(block.id ?? ""));
        }
        results.push(block);
      }
      cursor = json.has_more && json.next_cursor ? String(json.next_cursor) : undefined;
    } while (cursor);
    return results;
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const token = ctx.secrets?.token;
    if (!token) return null;
    const id = canonicalNotionId(source_id);
    const { res: pageRes, json: pageJson } = await this.requestJson(token, `${NOTION_API}/pages/${id}`);
    if (pageRes.ok && (pageJson.object === "page" || pageJson.properties)) {
      if (pageJson.archived || pageJson.in_trash) return null;
      const title = notionPageTitle(pageJson) || id;
      const frontmatter = flattenNotionProperties(pageJson.properties);
      const blocks = await this.fetchChildrenNested(token, String(pageJson.id ?? id));
      const converted = notionBlocksToMarkdown(blocks);
      const markdown = stableMarkdown(frontmatter, converted.markdown);
      return {
        source_id: id,
        path: title || id,
        title,
        raw: markdown,
        source_updated_at: String(pageJson.last_edited_time ?? "") || undefined,
      };
    }
    const { res: dbRes, json: dbJson } = await this.requestJson(token, `${NOTION_API}/databases/${id}`);
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

  async fetchAsset(_ctx: AdapterContext, _ref: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
}
