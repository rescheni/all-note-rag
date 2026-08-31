import type { Adapter, AdapterContext, Change, NotePayload, ProbeResult } from "@note-hub/core";
import { feishuBlocksToMarkdown } from "@note-hub/normalize";
import { fetchWithRetry } from "./http.ts";

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_API = "https://open.feishu.cn/open-apis";
const SKIP_TYPES = new Set(["sheet", "bitable", "file", "mindnote", "slides", "folder"]);

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class FeishuAdapter implements Adapter {
  private tenantToken: string | null = null;
  private noteMeta = new Map<string, { title: string; path: string }>();

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetchWithRetry(this.fetchFn, url, init);
  }

  private async readJson(res: Response): Promise<Record<string, unknown>> {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async fetchToken(ctx: AdapterContext): Promise<string | null> {
    if (this.tenantToken) return this.tenantToken;
    const app_id = ctx.secrets?.app_id;
    const app_secret = ctx.secrets?.app_secret;
    if (!app_id || !app_secret) return null;
    const res = await this.request(FEISHU_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id, app_secret }),
    });
    if (!res.ok) return null;
    const json = await this.readJson(res);
    if (Number(json.code ?? 0) !== 0) return null;
    const token = String(json.tenant_access_token ?? "");
    if (!token) return null;
    this.tenantToken = token;
    return token;
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const app_id = ctx.secrets?.app_id;
    const app_secret = ctx.secrets?.app_secret;
    if (!app_id || !app_secret) {
      return { ok: false, status: "error", message: "缺少飞书 app_id / app_secret" };
    }
    this.tenantToken = null;
    try {
      const res = await this.request(FEISHU_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id, app_secret }),
      });
      if (!res.ok) {
        return { ok: false, status: "error", message: `飞书探活失败 (${res.status})` };
      }
      const json = await this.readJson(res);
      if (Number(json.code ?? 0) !== 0) {
        return { ok: false, status: "error", message: String(json.msg ?? json.message ?? "飞书探活失败") };
      }
      const token = String(json.tenant_access_token ?? "");
      if (token) this.tenantToken = token;
      return { ok: true, status: "active" };
    } catch (err) {
      return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChanges(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const spaceId = ctx.connection.config.wiki_space_id;
    const prev = { ...(ctx.cursor ?? {}) };
    if (!spaceId) return { changes: [], nextCursor: prev };

    const token = await this.fetchToken(ctx);
    if (!token) throw new Error("飞书获取 token 失败");

    const allowed = new Set(ctx.connection.config.obj_types ?? ["docx"]);
    const changes: Change[] = [];
    const nextCursor: Record<string, unknown> = {};

    const walk = async (parent: string, pathPrefix: string, seen: Set<string>) => {
      let pageToken = "";
      do {
        const u = new URL(`${FEISHU_API}/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`);
        u.searchParams.set("page_size", "50");
        u.searchParams.set("parent_node_token", parent);
        if (pageToken) u.searchParams.set("page_token", pageToken);
        const res = await this.request(u.toString(), {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`飞书知识库列表失败 (${res.status})`);
        const json = await this.readJson(res);
        if (Number(json.code ?? 0) !== 0) {
          throw new Error(String(json.msg ?? json.message ?? "飞书知识库列表失败"));
        }
        const data = asDict(json.data) ?? {};
        const items = Array.isArray(data.items) ? data.items : [];
        for (const raw of items) {
          const node = asDict(raw);
          if (!node) continue;
          const nodeToken = String(node.node_token ?? "");
          if (nodeToken && seen.has(nodeToken)) continue;
          if (nodeToken) seen.add(nodeToken);
          const objToken = String(node.obj_token ?? "");
          const objType = String(node.obj_type ?? "");
          const title = String(node.title ?? objToken);
          const path = pathPrefix ? `${pathPrefix}/${title}` : title;
          const edit = String(node.obj_edit_time ?? node.revision_id ?? "");
          const skip = SKIP_TYPES.has(objType);
          const isDocx =
            !skip && (objType === "docx" || (objType === "wiki" && allowed.has("docx")) || allowed.has(objType));
          if (objToken && isDocx) {
            this.noteMeta.set(objToken, { title, path });
            nextCursor[objToken] = edit;
            const prevEdit = prev[objToken];
            if (prevEdit == null || String(prevEdit) !== edit) {
              changes.push({
                type: "upsert",
                source_id: objToken,
                path,
                source_updated_at: edit || undefined,
              });
            }
          }
          if (node.has_child && nodeToken) {
            await walk(nodeToken, path, seen);
          }
        }
        pageToken = data.has_more ? String(data.page_token ?? "") : "";
      } while (pageToken);
    };

    await walk("", "", new Set());
    return { changes, nextCursor };
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const token = await this.fetchToken(ctx);
    if (!token) return null;
    const items: unknown[] = [];
    let pageToken = "";
    do {
      const u = new URL(`${FEISHU_API}/docx/v1/documents/${encodeURIComponent(source_id)}/blocks`);
      u.searchParams.set("page_size", "500");
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const res = await this.request(u.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`飞书文档获取失败 (${res.status})`);
      const json = await this.readJson(res);
      if (Number(json.code ?? 0) !== 0) {
        return null;
      }
      const data = asDict(json.data) ?? {};
      const batch = Array.isArray(data.items) ? data.items : Array.isArray(data.blocks) ? data.blocks : [];
      items.push(...batch);
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);

    const converted = feishuBlocksToMarkdown(items);
    const meta = this.noteMeta.get(source_id);
    const title = meta?.title || converted.title || source_id;
    const path = meta?.path || title;
    const markdown = converted.markdown.endsWith("\n") ? converted.markdown : `${converted.markdown}\n`;
    return { source_id, path, title, raw: markdown };
  }

  async fetchAsset(_ctx: AdapterContext, _ref: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
}
