import type { Adapter, AdapterContext, Change, FeishuContactUser, NotePayload, ProbeResult } from "@note-hub/core";
import { guessContentType, parseFeishuContactItem } from "@note-hub/core";
import { feishuBlocksToMarkdown, feishuMediaRefs } from "@note-hub/normalize";
import { fetchWithRetry } from "./http.ts";

export type { FeishuContactUser };

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_API = "https://open.feishu.cn/open-apis";
const SKIP_TYPES = new Set(["sheet", "bitable", "mindnote", "slides", "folder"]);

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class FeishuAdapter implements Adapter {
  private tenantToken: string | null = null;
  private noteMeta = new Map<string, { title: string; path: string; objType: string }>();

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
          const isFile = objType === "file";
          const isDocx =
            !skip &&
            !isFile &&
            (objType === "docx" || (objType === "wiki" && allowed.has("docx")) || allowed.has(objType));
          if (objToken && (isDocx || isFile)) {
            this.noteMeta.set(objToken, { title, path, objType });
            nextCursor[objToken] = edit;
            const meta = asDict(nextCursor.__meta) ?? {};
            meta[objToken] = { title, path, obj_type: objType };
            nextCursor.__meta = meta;
            const prevEdit = prev[objToken];
            const prevStr = prevEdit && typeof prevEdit === "object" ? String(asDict(prevEdit)?.edit ?? prevEdit) : prevEdit == null ? "" : String(prevEdit);
            if (prevEdit == null || prevStr !== edit) {
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

  private metaOf(ctx: AdapterContext, source_id: string): { title: string; path: string; objType: string } | undefined {
    const local = this.noteMeta.get(source_id);
    if (local) return local;
    const meta = asDict((ctx.cursor ?? {}).__meta)?.[source_id];
    const rec = asDict(meta);
    if (!rec) return undefined;
    return {
      title: String(rec.title ?? source_id),
      path: String(rec.path ?? rec.title ?? source_id),
      objType: String(rec.obj_type ?? ""),
    };
  }

  private async downloadMedia(token: string, fileToken: string): Promise<Uint8Array> {
    const urls = [
      `${FEISHU_API}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      `${FEISHU_API}/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
    ];
    for (const url of urls) {
      const res = await this.request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) continue;
      const head = new TextDecoder().decode(buf.slice(0, Math.min(buf.length, 40))).trim();
      if (head.startsWith("{")) {
        try {
          const json = JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
          if (Number(json.code ?? 0) !== 0) continue;
        } catch {
          return buf;
        }
        continue;
      }
      return buf;
    }
    return new Uint8Array();
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const token = await this.fetchToken(ctx);
    if (!token) return null;
    const meta = this.metaOf(ctx, source_id);
    if (meta?.objType === "file") {
      const bytes = await this.downloadMedia(token, source_id);
      const name = meta.title || source_id;
      return {
        source_id,
        path: meta.path || name,
        title: name,
        raw: "",
        kind: "asset",
        assets: bytes.byteLength ? [{ path: name, bytes, contentType: guessContentType(name) }] : [],
      };
    }
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
      if (res.status === 404) {
        const bytes = await this.downloadMedia(token, source_id);
        if (!bytes.byteLength) return null;
        const name = meta?.title || source_id;
        return {
          source_id,
          path: meta?.path || name,
          title: name,
          raw: "",
          kind: "asset",
          assets: [{ path: name, bytes, contentType: guessContentType(name) }],
        };
      }
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
    const title = meta?.title || converted.title || source_id;
    const path = meta?.path || title;
    const markdown = converted.markdown.endsWith("\n") ? converted.markdown : `${converted.markdown}\n`;
    const assets: NonNullable<NotePayload["assets"]> = [];
    for (const media of feishuMediaRefs(items)) {
      const bytes = await this.downloadMedia(token, media.token);
      if (!bytes.byteLength) continue;
      assets.push({ path: media.name, bytes, contentType: guessContentType(media.name) });
    }
    return { source_id, path, title, raw: markdown, assets };
  }


  async fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    const token = await this.fetchToken(ctx);
    if (!token) return new Uint8Array();
    return this.downloadMedia(token, ref);
  }

  private async pagedJson(
    token: string,
    url: URL,
    itemsKey: "items" | "user_ids" | "department_ids" = "items",
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let pageToken = "";
    do {
      const u = new URL(url.toString());
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const res = await this.request(u.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return out;
      const json = await this.readJson(res);
      if (Number(json.code ?? 0) !== 0) return out;
      const data = asDict(json.data) ?? {};
      const batch = Array.isArray(data[itemsKey]) ? (data[itemsKey] as unknown[]) : [];
      out.push(...batch);
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);
    return out;
  }

  private async listDepartmentIds(token: string): Promise<string[]> {
    const ids = new Set<string>(["0"]);
    const childrenUrl = new URL(`${FEISHU_API}/contact/v3/departments/0/children`);
    childrenUrl.searchParams.set("fetch_child", "true");
    childrenUrl.searchParams.set("page_size", "50");
    childrenUrl.searchParams.set("department_id_type", "open_department_id");
    const children = await this.pagedJson(token, childrenUrl);
    for (const raw of children) {
      const rec = asDict(raw);
      if (!rec) continue;
      const id = String(rec.open_department_id ?? rec.department_id ?? "").trim();
      if (id) ids.add(id);
    }
    const scopesUrl = new URL(`${FEISHU_API}/contact/v3/scopes`);
    scopesUrl.searchParams.set("page_size", "50");
    scopesUrl.searchParams.set("user_id_type", "open_id");
    scopesUrl.searchParams.set("department_id_type", "open_department_id");
    let pageToken = "";
    do {
      const u = new URL(scopesUrl.toString());
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const res = await this.request(u.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const json = await this.readJson(res);
      if (Number(json.code ?? 0) !== 0) break;
      const data = asDict(json.data) ?? {};
      const depts = Array.isArray(data.department_ids) ? data.department_ids : [];
      for (const d of depts) {
        const id = String(d ?? "").trim();
        if (id) ids.add(id);
      }
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);
    return [...ids];
  }

  private async listUsersInDepartment(token: string, departmentId: string): Promise<unknown[]> {
    const u = new URL(`${FEISHU_API}/contact/v3/users/find_by_department`);
    u.searchParams.set("department_id", departmentId);
    u.searchParams.set("department_id_type", "open_department_id");
    u.searchParams.set("user_id_type", "open_id");
    u.searchParams.set("page_size", "50");
    return this.pagedJson(token, u);
  }

  /** Walk departments via contact v3 and return unique directory users. */
  async listContacts(ctx: AdapterContext): Promise<FeishuContactUser[]> {
    const token = await this.fetchToken(ctx);
    if (!token) throw new Error("飞书获取 token 失败");
    const byOpen = new Map<string, FeishuContactUser>();
    const deptIds = await this.listDepartmentIds(token);
    for (const deptId of deptIds) {
      const items = await this.listUsersInDepartment(token, deptId);
      for (const raw of items) {
        const user = parseFeishuContactItem(raw);
        if (user) byOpen.set(user.open_id, user);
      }
    }
    return [...byOpen.values()];
  }
}
