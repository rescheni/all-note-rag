import type { Adapter, AdapterContext, Change, FeishuContactUser, NotePayload, ProbeResult } from "@note-hub/core";
import { guessContentType, parseFeishuContactItem } from "@note-hub/core";
import { feishuBlocksToMarkdown, feishuMediaRefs } from "@note-hub/normalize";
import { fetchWithRetry } from "./http.ts";
import {
  applyFeishuOAuthSecrets,
  feishuAccessTokenFresh,
  feishuOAuthClient,
  feishuRefreshFailureMessage,
  feishuRefreshTokenExpired,
  feishuUserAccessToken,
  refreshFeishuAccessToken,
  FeishuTokenError,
} from "./feishu-oauth.ts";

export type { FeishuContactUser };
export {
  applyFeishuOAuthSecrets,
  buildFeishuAuthorizeUrl,
  exchangeFeishuAuthorizationCode,
  feishuAccessTokenFresh,
  feishuOAuthClient,
  feishuRefreshFailureMessage,
  feishuRefreshTokenExpired,
  feishuUserAccessToken,
  refreshFeishuAccessToken,
  FeishuTokenError,
  FEISHU_AUTHORIZE_URL,
  FEISHU_OAUTH_SCOPES,
  FEISHU_OAUTH_TOKEN_URL,
} from "./feishu-oauth.ts";

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_API = "https://open.feishu.cn/open-apis";

/** Shown when user_access_token expired and refresh_token is missing or refresh fails. */
const FEISHU_USER_TOKEN_EXPIRED_MSG =
  "用户令牌已过期且无法刷新，请重新扫码（需刷新令牌 / offline_access；已有笔记与增量游标会保留）";
const FEISHU_REFRESH_MISSING_MSG =
  "缺少飞书刷新令牌，请重新扫码并确认授权 offline_access（已有笔记与增量游标会保留）";
const SKIP_TYPES = new Set(["sheet", "bitable", "mindnote", "slides", "folder"]);
const USER_TOKEN_AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991677]);
/** Skip absurd media so one huge video can never blow up a note ingest. */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;


/** Feishu /wiki/v2/spaces/{space_id}/nodes requires a numeric space_id. */
export function isNumericWikiSpaceId(s: string): boolean {
  return /^[0-9]+$/.test(s.trim());
}

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class FeishuAdapter implements Adapter {
  private lastUserRefreshError: string | undefined;
  private tenantToken: string | null = null;
  private refreshInFlight: Promise<string | undefined> | null = null;
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

  private isTokenAuthError(res: Response, json?: Record<string, unknown>): boolean {
    if (res.status === 401) return true;
    const code = Number(json?.code ?? 0);
    return USER_TOKEN_AUTH_CODES.has(code);
  }

  private async fetchTenantToken(ctx: AdapterContext): Promise<string | null> {
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

  /** Prefer a fresh user_access_token; else tenant_access_token. */
  private async getBearer(ctx: AdapterContext): Promise<string | null> {
    return this.ensureUserBearer(ctx);
  }

  /**
   * Refresh user_access_token when missing/stale.
   * Feishu refresh_token is single-use: serialize via withSecretsLock, re-read on 20064,
   * and always persist the rotated refresh_token.
   */
  private async refreshUserIfPossible(ctx: AdapterContext, force = false): Promise<string | undefined> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runUserRefresh(ctx, force).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async runUserRefresh(ctx: AdapterContext, force: boolean): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      const accessBefore = feishuUserAccessToken(ctx.secrets);
      if (ctx.reloadSecrets) {
        try {
          const latest = await ctx.reloadSecrets();
          if (latest) ctx.secrets = latest;
        } catch {
          /* keep in-memory secrets */
        }
      }

      const accessNow = feishuUserAccessToken(ctx.secrets);
      const fresh = feishuAccessTokenFresh(ctx.secrets);
      // Reuse when still fresh, or when a peer already rotated the access_token under the lock.
      if (accessNow && fresh && (!force || accessNow !== accessBefore)) {
        this.lastUserRefreshError = undefined;
        return accessNow;
      }

      const refreshToken = ctx.secrets?.refresh_token?.trim() ?? "";
      const client = feishuOAuthClient(ctx.secrets);
      if (!refreshToken || !client) {
        this.lastUserRefreshError = refreshToken ? FEISHU_USER_TOKEN_EXPIRED_MSG : FEISHU_REFRESH_MISSING_MSG;
        return undefined;
      }
      if (feishuRefreshTokenExpired(ctx.secrets)) {
        this.lastUserRefreshError = "飞书刷新令牌已过期，请重新扫码登录（已有笔记与增量游标会保留）";
        return undefined;
      }

      const attempt = async (rt: string) =>
        refreshFeishuAccessToken({
          refreshToken: rt,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          fetchFn: this.fetchFn,
        });

      try {
        let tokens;
        try {
          tokens = await attempt(refreshToken);
        } catch (err) {
          // Another worker may have rotated the single-use refresh_token — reload and retry once.
          const code = err instanceof FeishuTokenError ? err.code : 0;
          if ((code === 20064 || code === 20073 || code === 20026) && ctx.reloadSecrets) {
            const latest = await ctx.reloadSecrets();
            if (latest) ctx.secrets = latest;
            const again = ctx.secrets?.refresh_token?.trim() ?? "";
            if (again && again !== refreshToken) {
              tokens = await attempt(again);
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
        const next = applyFeishuOAuthSecrets(ctx.secrets, tokens);
        ctx.secrets = next;
        this.lastUserRefreshError = undefined;
        if (ctx.persistSecrets) {
          try {
            await ctx.persistSecrets(next);
          } catch {
            /* keep using in-memory token even if persist fails */
          }
        }
        return tokens.access_token;
      } catch (err) {
        this.lastUserRefreshError = feishuRefreshFailureMessage(err);
        return undefined;
      }
    };

    if (ctx.withSecretsLock) return ctx.withSecretsLock(run);
    return run();
  }

  /** Prefer a fresh user token; refresh proactively when expiry is known. */
  private async ensureUserBearer(ctx: AdapterContext): Promise<string | null> {
    const user = feishuUserAccessToken(ctx.secrets);
    if (!user) return this.fetchTenantToken(ctx);
    if (feishuAccessTokenFresh(ctx.secrets)) return user;
    // Legacy secrets without expires_at: use token until API 401 forces refresh.
    if (!ctx.secrets?.access_token_expires_at) return user;
    const refreshed = await this.refreshUserIfPossible(ctx, true);
    if (refreshed) return refreshed;
    return null;
  }

  private async requestAuthed(ctx: AdapterContext, url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getBearer(ctx);
    if (!token) return new Response("{}", { status: 401 });
    const headers = { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
    const res = await this.request(url, { ...init, headers });
    if (res.status !== 401) return res;
    const next = await this.refreshUserIfPossible(ctx, true);
    if (!next) return res;
    return this.request(url, {
      ...init,
      headers: { authorization: `Bearer ${next}`, ...(init.headers as Record<string, string> | undefined) },
    });
  }

  private async apiJson(
    ctx: AdapterContext,
    url: string,
    init: RequestInit = {},
  ): Promise<{ res: Response; json: Record<string, unknown> }> {
    const doOne = async (token: string) => {
      const res = await this.request(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
      });
      const json = await this.readJson(res);
      return { res, json };
    };
    const token = await this.getBearer(ctx);
    if (!token) return { res: new Response("{}", { status: 401 }), json: {} };
    let out = await doOne(token);
    if (this.isTokenAuthError(out.res, out.json)) {
      const next = await this.refreshUserIfPossible(ctx, true);
      if (next) out = await doOne(next);
    }
    return out;
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const user = feishuUserAccessToken(ctx.secrets);
    if (user) {
      try {
        const u = new URL(`${FEISHU_API}/wiki/v2/spaces`);
        u.searchParams.set("page_size", "1");
        const { res, json } = await this.apiJson(ctx, u.toString());
        if (res.ok && Number(json.code ?? 0) === 0) return { ok: true, status: "active" };
        if (this.isTokenAuthError(res, json)) {
          return {
            ok: false,
            status: "error",
            message: this.lastUserRefreshError || FEISHU_USER_TOKEN_EXPIRED_MSG,
          };
        }
      } catch (err) {
        return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
      }
    }
    const app_id = ctx.secrets?.app_id;
    const app_secret = ctx.secrets?.app_secret;
    if (!app_id || !app_secret) {
      if (user) return { ok: false, status: "error", message: "飞书探活失败" };
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
      const wikiSpace = String(ctx.connection.config.wiki_space_id ?? "").trim();
      if (isNumericWikiSpaceId(wikiSpace)) {
        const u = new URL(`${FEISHU_API}/wiki/v2/spaces/${encodeURIComponent(wikiSpace)}/nodes`);
        u.searchParams.set("page_size", "1");
        const nodes = await this.apiJson(ctx, u.toString());
        const nCode = Number(nodes.json.code ?? 0);
        const nMsg = String(nodes.json.msg ?? nodes.json.message ?? "");
        if (nCode === 131006 || /permission denied/i.test(nMsg)) {
          return {
            ok: false,
            status: "error",
            message:
              "应用无权列举该知识库节点。请扫码登录飞书（推荐），或将应用添加为知识库成员后重试。",
          };
        }
      }
      return { ok: true, status: "active" };
    } catch (err) {
      return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  private parseWikiNodeToken(raw: string): string {
    const s = raw.trim();
    if (!s) return "";
    try {
      const u = new URL(s);
      const m = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
      if (m?.[1]) return m[1];
    } catch {
      /* not a URL */
    }
    return s;
  }

  private async listWikiSpaces(ctx: AdapterContext): Promise<{ space_id: string; name: string }[]> {
    const out: { space_id: string; name: string }[] = [];
    let pageToken = "";
    do {
      const u = new URL(`${FEISHU_API}/wiki/v2/spaces`);
      u.searchParams.set("page_size", "50");
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const { res, json } = await this.apiJson(ctx, u.toString());
      if (!res.ok || Number(json.code ?? 0) !== 0) break;
      const data = asDict(json.data) ?? {};
      const items = Array.isArray(data.items) ? data.items : [];
      for (const raw of items) {
        const rec = asDict(raw);
        if (!rec) continue;
        const space_id = String(rec.space_id ?? "").trim();
        if (!space_id) continue;
        out.push({ space_id, name: String(rec.name ?? space_id) });
      }
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);
    return out;
  }

  private async listDriveDocx(
    ctx: AdapterContext,
    ingest: (node: Record<string, unknown>, pathPrefix: string) => void,
  ): Promise<void> {
    let rootToken = "";
    try {
      const { res, json } = await this.apiJson(ctx, `${FEISHU_API}/drive/explorer/v2/root_folder/meta`);
      if (res.ok && Number(json.code ?? 0) === 0) {
        const data = asDict(json.data) ?? {};
        rootToken = String(data.token ?? data.id ?? "").trim();
      }
    } catch {
      rootToken = "";
    }
    const seenFolders = new Set<string>();
    const walkFolder = async (folderToken: string, pathPrefix: string, depth: number) => {
      if (depth > 12) return;
      const key = folderToken || "__root__";
      if (seenFolders.has(key)) return;
      seenFolders.add(key);
      let pageToken = "";
      do {
        const u = new URL(`${FEISHU_API}/drive/v1/files`);
        u.searchParams.set("page_size", "50");
        if (folderToken) u.searchParams.set("folder_token", folderToken);
        if (pageToken) u.searchParams.set("page_token", pageToken);
        const { res, json } = await this.apiJson(ctx, u.toString());
        if (!res.ok || Number(json.code ?? 0) !== 0) return;
        const data = asDict(json.data) ?? {};
        const files = Array.isArray(data.files) ? data.files : Array.isArray(data.items) ? data.items : [];
        for (const raw of files) {
          const rec = asDict(raw);
          if (!rec) continue;
          const type = String(rec.type ?? "");
          const name = String(rec.name ?? rec.token ?? "");
          const token = String(rec.token ?? "");
          const path = pathPrefix ? `${pathPrefix}/${name}` : name;
          const edited = String(rec.modified_time ?? rec.created_time ?? "");
          if (type === "folder" && token) {
            await walkFolder(token, path, depth + 1);
            continue;
          }
          const shortcut = asDict(rec.shortcut_info);
          const targetType = String(shortcut?.target_type ?? "");
          const targetToken = String(shortcut?.target_token ?? "");
          const isDocx = type === "docx" || (type === "shortcut" && targetType === "docx");
          if (!isDocx) continue;
          const objToken = type === "shortcut" ? targetToken || token : token;
          if (!objToken) continue;
          ingest(
            { obj_token: objToken, obj_type: "docx", title: name, obj_edit_time: edited, node_token: objToken },
            pathPrefix,
          );
        }
        pageToken = data.has_more ? String(data.next_page_token ?? data.page_token ?? "") : "";
      } while (pageToken);
    };
    await walkFolder(rootToken, "我的文档库", 0);
  }

  async listChanges(
    ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const prev = { ...(ctx.cursor ?? {}) };
    const rawSpace = String(ctx.connection.config.wiki_space_id ?? "").trim();
    let nodeToken = this.parseWikiNodeToken(String(ctx.connection.config.wiki_node_token ?? ""));
    let spaceId = "";
    if (isNumericWikiSpaceId(rawSpace)) {
      spaceId = rawSpace.trim();
    } else if (rawSpace) {
      // Non-numeric wiki_space_id is almost always a pasted node token/URL — never use as path param.
      const fromSpace = this.parseWikiNodeToken(rawSpace);
      if (fromSpace && !nodeToken) nodeToken = fromSpace;
    }
    const hasUser = Boolean(feishuUserAccessToken(ctx.secrets));
    if (!spaceId && !nodeToken && !hasUser) return { changes: [], nextCursor: prev };

    const token = await this.getBearer(ctx);
    if (!token) throw new Error("飞书获取 token 失败");

    const allowed = new Set(ctx.connection.config.obj_types ?? ["docx"]);
    const changes: Change[] = [];
    const nextCursor: Record<string, unknown> = {};
    const seenNodes = new Set<string>();
    const seenObj = new Set<string>();

    const ingest = (node: Record<string, unknown>, pathPrefix: string) => {
      const nt = String(node.node_token ?? "");
      if (nt && seenNodes.has(nt)) return;
      const objToken = String(node.obj_token ?? "");
      if (objToken && seenObj.has(objToken)) return;
      if (nt) seenNodes.add(nt);
      if (objToken) seenObj.add(objToken);
      const objType = String(node.obj_type ?? "");
      const title = String(node.title ?? objToken);
      const path = pathPrefix ? `${pathPrefix}/${title}` : title;
      const edit = String(node.obj_edit_time ?? node.revision_id ?? "");
      const skip = SKIP_TYPES.has(objType);
      const isFile = objType === "file";
      const isDocx =
        !skip &&
        !isFile &&
        (objType === "docx" ||
          objType === "doc" ||
          (objType === "wiki" && allowed.has("docx")) ||
          allowed.has(objType));
      if (objToken && (isDocx || isFile)) {
        this.noteMeta.set(objToken, { title, path, objType });
        nextCursor[objToken] = edit;
        const meta = asDict(nextCursor.__meta) ?? {};
        meta[objToken] = { title, path, obj_type: objType };
        nextCursor.__meta = meta;
        const prevEdit = prev[objToken];
        const prevStr =
          prevEdit && typeof prevEdit === "object"
            ? String(asDict(prevEdit)?.edit ?? prevEdit)
            : prevEdit == null
              ? ""
              : String(prevEdit);
        if (prevEdit == null || prevStr !== edit) {
          changes.push({
            type: "upsert",
            source_id: objToken,
            path,
            source_updated_at: edit || undefined,
          });
        }
      }
    };

    const wikiPermErrors: string[] = [];
    const walkedSpaces = new Set<string>();

    const walk = async (sid: string, parent: string, pathPrefix: string): Promise<number> => {
      if (!isNumericWikiSpaceId(sid)) {
        console.warn(JSON.stringify({ level: "warn", message: "feishu skip non-numeric space_id", space_id: sid }));
        return 0;
      }
      let listed = 0;
      let pageToken = "";
      do {
        const u = new URL(`${FEISHU_API}/wiki/v2/spaces/${encodeURIComponent(sid)}/nodes`);
        u.searchParams.set("page_size", "50");
        // Feishu root listing: omit parent_node_token (empty string is not "root").
        if (parent) u.searchParams.set("parent_node_token", parent);
        if (pageToken) u.searchParams.set("page_token", pageToken);
        const { res, json } = await this.apiJson(ctx, u.toString());
        const code = Number(json.code ?? 0);
        const msg = String(json.msg ?? json.message ?? "");
        if (!res.ok || code !== 0) {
          if (code === 131006 || /permission denied/i.test(msg)) {
            const err = `知识库 ${sid} 无权列举节点（${code || res.status}）：${msg || "permission denied"}`;
            wikiPermErrors.push(err);
            console.warn(JSON.stringify({ level: "warn", message: "feishu wiki permission denied", space_id: sid, code, msg }));
            return listed;
          }
          throw new Error(msg || `飞书知识库列表失败 (${res.status})`);
        }
        const data = asDict(json.data) ?? {};
        const items = Array.isArray(data.items) ? data.items : [];
        for (const raw of items) {
          const node = asDict(raw);
          if (!node) continue;
          listed += 1;
          ingest(node, pathPrefix);
          const nt = String(node.node_token ?? "");
          const title = String(node.title ?? node.obj_token ?? "");
          const path = pathPrefix ? `${pathPrefix}/${title}` : title;
          if (node.has_child && nt) await walk(sid, nt, path);
        }
        pageToken = data.has_more ? String(data.page_token ?? "") : "";
      } while (pageToken);
      return listed;
    };

    const walkSpace = async (sid: string, pathPrefix: string): Promise<number> => {
      if (!isNumericWikiSpaceId(sid) || walkedSpaces.has(sid)) return 0;
      walkedSpaces.add(sid);
      return walk(sid, "", pathPrefix);
    };

    let wikiListed = 0;
    let configuredNode: Record<string, unknown> | null = null;
    if (nodeToken) {
      const u = new URL(`${FEISHU_API}/wiki/v2/spaces/get_node`);
      u.searchParams.set("token", nodeToken);
      const { res, json } = await this.apiJson(ctx, u.toString());
      if (!res.ok || Number(json.code ?? 0) !== 0) {
        const code = Number(json.code ?? 0);
        const msg = String(json.msg ?? json.message ?? "");
        if (code === 131006 || /permission denied/i.test(msg)) {
          throw new Error(
            `飞书知识库节点无权访问（${code || res.status}）。请重新扫码登录，或确认该页面已授权给应用。`,
          );
        }
        throw new Error(msg || `飞书节点获取失败 (${res.status})`);
      }
      configuredNode = asDict(asDict(json.data)?.node) ?? asDict(json.data);
      if (configuredNode) {
        ingest(configuredNode, "");
        const sid = String(configuredNode.space_id ?? "").trim();
        // Always take numeric space_id from get_node; never keep a pasted token as spaceId.
        if (isNumericWikiSpaceId(sid)) spaceId = sid;
        // Walk subtree under the configured node when it has children.
        if (configuredNode.has_child && isNumericWikiSpaceId(sid)) {
          const title = String(configuredNode.title ?? configuredNode.obj_token ?? "");
          wikiListed += await walk(sid, nodeToken, title);
        }
      }
    }

    if (hasUser) {
      // Honor configured wiki_space_id first (user may narrow scope).
      if (spaceId) wikiListed += await walkSpace(spaceId, "");
      const spaces = await this.listWikiSpaces(ctx);
      if (!spaces.length && !spaceId && !nodeToken) {
        console.warn(JSON.stringify({ level: "warn", message: "feishu wiki spaces empty", hint: "token may lack wiki scopes" }));
      }
      for (const sp of spaces) {
        // Skip re-walk of configured space; still walk other accessible knowledge bases.
        wikiListed += await walkSpace(sp.space_id, sp.name);
      }
      // Personal cloud docs (云空间) — keep under 我的文档库, separate from 知识库 tree.
      await this.listDriveDocx(ctx, ingest);
    } else if (spaceId) {
      wikiListed += await walkSpace(spaceId, "");
    }

    const targetedWiki = Boolean(spaceId || nodeToken);
    if (targetedWiki && wikiPermErrors.length && wikiListed === 0) {
      const detail = wikiPermErrors[0];
      if (hasUser) {
        throw new Error(
          `${detail}。请确认账号是该知识库成员，并在飞书开放平台开通 wiki:wiki:readonly / wiki:node:retrieve / docx:document:readonly。`,
        );
      }
      throw new Error(
        `${detail}。知识库同步需要用户扫码授权（user_access_token）；仅用应用身份时请将应用添加为该知识库成员。请点击「用飞书扫码登录」后重试。`,
      );
    }

    console.log(
      JSON.stringify({
        level: "info",
        message: "feishu listChanges",
        has_user: hasUser,
        space_id: spaceId || null,
        node_token: nodeToken || null,
        wiki_listed: wikiListed,
        changes: changes.length,
        wiki_perm_errors: wikiPermErrors.length,
      }),
    );

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

  private async downloadMedia(ctx: AdapterContext, fileToken: string): Promise<Uint8Array> {
    const urls = [
      `${FEISHU_API}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      `${FEISHU_API}/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
    ];
    for (const url of urls) {
      const res = await this.requestAuthed(ctx, url, { method: "GET" });
      if (!res.ok) continue;
      const declared = Number(res.headers?.get?.("content-length") ?? 0);
      if (declared && declared > MAX_MEDIA_BYTES) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "feishu media skipped",
            reason: `too large (${declared} bytes)`,
            file_token: fileToken,
          }),
        );
        return new Uint8Array();
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) continue;
      if (buf.byteLength > MAX_MEDIA_BYTES) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "feishu media skipped",
            reason: `too large (${buf.byteLength} bytes)`,
            file_token: fileToken,
          }),
        );
        return new Uint8Array();
      }
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

  private async fetchMarkdownContent(ctx: AdapterContext, docToken: string): Promise<string | null> {
    const u = new URL(`${FEISHU_API}/docs/v1/content`);
    u.searchParams.set("doc_token", docToken);
    u.searchParams.set("content_type", "markdown");
    const { res, json } = await this.apiJson(ctx, u.toString());
    if (!res.ok || Number(json.code ?? 0) !== 0) return null;
    const data = asDict(json.data) ?? {};
    const content = typeof data.content === "string" ? data.content : typeof json.content === "string" ? json.content : "";
    return content.trim() ? content : null;
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const token = await this.getBearer(ctx);
    if (!token) return null;
    const meta = this.metaOf(ctx, source_id);
    if (meta?.objType === "file") {
      const bytes = await this.downloadMedia(ctx, source_id);
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
    let blocksFailed = false;
    do {
      const u = new URL(`${FEISHU_API}/docx/v1/documents/${encodeURIComponent(source_id)}/blocks`);
      u.searchParams.set("page_size", "500");
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const { res, json } = await this.apiJson(ctx, u.toString());
      if (res.status === 404) {
        const bytes = await this.downloadMedia(ctx, source_id);
        if (!bytes.byteLength) {
          const md = await this.fetchMarkdownContent(ctx, source_id);
          if (!md) return null;
          const name = meta?.title || source_id;
          return { source_id, path: meta?.path || name, title: name, raw: md.endsWith("\n") ? md : `${md}\n` };
        }
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
      if (!res.ok || Number(json.code ?? 0) !== 0) {
        blocksFailed = true;
        break;
      }
      const data = asDict(json.data) ?? {};
      const batch = Array.isArray(data.items) ? data.items : Array.isArray(data.blocks) ? data.blocks : [];
      items.push(...batch);
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);

    if (blocksFailed || items.length === 0) {
      const md = await this.fetchMarkdownContent(ctx, source_id);
      if (md) {
        const title = meta?.title || source_id;
        const path = meta?.path || title;
        const markdown = md.endsWith("\n") ? md : `${md}\n`;
        return { source_id, path, title, raw: markdown };
      }
      if (blocksFailed) return null;
    }

    const converted = feishuBlocksToMarkdown(items);
    const title = meta?.title || converted.title || source_id;
    const path = meta?.path || title;
    const markdown = converted.markdown.endsWith("\n") ? converted.markdown : `${converted.markdown}\n`;
    const assets: NonNullable<NotePayload["assets"]> = [];
    // image (27) + file (23, incl. audio/video) tokens. One bad attachment must not fail the note.
    for (const media of feishuMediaRefs(items)) {
      try {
        const bytes = await this.downloadMedia(ctx, media.token);
        if (!bytes.byteLength) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "feishu media skipped",
              reason: "empty or unauthorized download",
              kind: media.kind,
              name: media.name,
              source_id,
            }),
          );
          continue;
        }
        assets.push({ path: media.name, bytes, contentType: guessContentType(media.name) });
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "feishu media skipped",
            reason: err instanceof Error ? err.message : String(err),
            kind: media.kind,
            name: media.name,
            source_id,
          }),
        );
      }
    }
    return { source_id, path, title, raw: markdown, assets };
  }

  async fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    const token = await this.getBearer(ctx);
    if (!token) return new Uint8Array();
    return this.downloadMedia(ctx, ref);
  }

  private async pagedJson(
    ctx: AdapterContext,
    url: URL,
    itemsKey: "items" | "user_ids" | "department_ids" = "items",
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let pageToken = "";
    do {
      const u = new URL(url.toString());
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const { res, json } = await this.apiJson(ctx, u.toString());
      if (!res.ok || Number(json.code ?? 0) !== 0) return out;
      const data = asDict(json.data) ?? {};
      const batch = Array.isArray(data[itemsKey]) ? (data[itemsKey] as unknown[]) : [];
      out.push(...batch);
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
    } while (pageToken);
    return out;
  }

  private async listDepartmentIds(ctx: AdapterContext): Promise<string[]> {
    const ids = new Set<string>(["0"]);
    const childrenUrl = new URL(`${FEISHU_API}/contact/v3/departments/0/children`);
    childrenUrl.searchParams.set("fetch_child", "true");
    childrenUrl.searchParams.set("page_size", "50");
    childrenUrl.searchParams.set("department_id_type", "open_department_id");
    const children = await this.pagedJson(ctx, childrenUrl);
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
      const { res, json } = await this.apiJson(ctx, u.toString());
      if (!res.ok || Number(json.code ?? 0) !== 0) break;
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

  private async listUsersInDepartment(ctx: AdapterContext, departmentId: string): Promise<unknown[]> {
    const u = new URL(`${FEISHU_API}/contact/v3/users/find_by_department`);
    u.searchParams.set("department_id", departmentId);
    u.searchParams.set("department_id_type", "open_department_id");
    u.searchParams.set("user_id_type", "open_id");
    u.searchParams.set("page_size", "50");
    return this.pagedJson(ctx, u);
  }

  /** Walk departments via contact v3 and return unique directory users. */
  async listContacts(ctx: AdapterContext): Promise<FeishuContactUser[]> {
    const token = await this.getBearer(ctx);
    if (!token) throw new Error("飞书获取 token 失败");
    const byOpen = new Map<string, FeishuContactUser>();
    const deptIds = await this.listDepartmentIds(ctx);
    for (const deptId of deptIds) {
      const items = await this.listUsersInDepartment(ctx, deptId);
      for (const raw of items) {
        const user = parseFeishuContactItem(raw);
        if (user) byOpen.set(user.open_id, user);
      }
    }
    return [...byOpen.values()];
  }
}
