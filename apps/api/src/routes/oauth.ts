import { Hono, type Context } from "hono";
import {
  applyFeishuOAuthSecrets,
  applyNotionOAuthSecrets,
  buildFeishuAuthorizeUrl,
  buildFeishuQrGotoUrl,
  buildNotionAuthorizeUrl,
  exchangeFeishuAuthorizationCode,
  exchangeNotionAuthorizationCode,
  feishuOAuthClient,
} from "@note-hub/adapters";
import {
  isAllowedOAuthOrigin,
  oauthCallbackRedirectUri,
  resolveOAuthRedirectOrigin,
  signOAuthState,
  verifyOAuthState,
  type ConnectionSecrets,
} from "@note-hub/core";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { persistEncryptedSecrets, decryptConnectionSecrets } from "../connection-util.ts";
import { query } from "../db.ts";
import { env, feishuOAuthEnv, notionOAuthEnv } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { enqueueSync } from "../queue.ts";

type Vars = { user: AuthUser };
export const oauthRoutes = new Hono<{ Variables: Vars }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pageOrigin(requested?: string | null): string {
  if (requested && isAllowedOAuthOrigin(requested)) return requested.replace(/\/$/, "");
  return env.webOrigin.replace(/\/$/, "");
}

function webRedirect(path: string, origin?: string | null): string {
  const base = pageOrigin(origin);
  return base + (path.startsWith("/") ? path : `/${path}`);
}

function oauthErrorUrl(message: string, connectionId?: string, source = "notion", origin?: string | null): string {
  const q = new URLSearchParams({ oauth_error: message });
  if (connectionId && UUID_RE.test(connectionId)) {
    return webRedirect(`/connections/${connectionId}?${q.toString()}`, origin);
  }
  q.set("source", source);
  return webRedirect(`/connections/new?${q.toString()}`, origin);
}

function oauthOkUrl(connectionId: string, origin?: string | null): string {
  return webRedirect(`/connections/${connectionId}?oauth=ok`, origin);
}

function nonceCookie(nonce: string, maxAge: number, secure = false): string {
  const parts = [
    `hub_oauth_nonce=${encodeURIComponent(nonce)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

oauthRoutes.get("/connections/oauth/notion/status", requireUser, async (c) => {
  return c.json({
    configured: notionOAuthEnv.configured,
    redirect_uri: notionOAuthEnv.redirectUri,
  });
});

oauthRoutes.get("/connections/oauth/notion/authorize", requireUser, async (c) => {
  const user = c.get("user");
  if (!notionOAuthEnv.configured) {
    return jsonError(
      c,
      400,
      "oauth_not_configured",
      "尚未配置 Notion OAuth（NOTION_CLIENT_ID / NOTION_CLIENT_SECRET）。可改用 Integration Token。",
    );
  }
  const spaceId = (c.req.query("space_id") ?? "").trim();
  if (!UUID_RE.test(spaceId)) {
    return jsonError(c, 400, "invalid_request", "缺少 space_id");
  }
  const gate = await requireRole(user.id, spaceId, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  const connectionId = (c.req.query("connection_id") ?? "").trim();
  if (connectionId) {
    if (!UUID_RE.test(connectionId)) {
      return jsonError(c, 400, "invalid_request", "连接 ID 无效");
    }
    const row = await query<{ id: string; source: string; space_id: string }>(
      "SELECT id, source, space_id FROM connections WHERE id = $1",
      [connectionId],
    );
    const conn = row.rows[0];
    if (!conn || conn.space_id !== spaceId) return errors.notFound(c);
    if (conn.source !== "notion") {
      return jsonError(c, 400, "invalid_request", "该连接不是 Notion");
    }
  }

  const name = (c.req.query("name") ?? "").trim() || "我的 Notion";
  const ws = (c.req.query("workspace_id") ?? "").trim();
  const { state, nonce } = signOAuthState(
    {
      uid: user.id,
      sid: spaceId,
      cid: connectionId || undefined,
      name,
      ws: ws || undefined,
    },
    env.hubSecret,
  );
  const url = buildNotionAuthorizeUrl({
    clientId: notionOAuthEnv.clientId,
    redirectUri: notionOAuthEnv.redirectUri,
    state,
  });
  c.header("Set-Cookie", nonceCookie(nonce, 600));
  return c.json({ url });
});

oauthRoutes.get("/connections/oauth/notion/callback", async (c) => {
  const denied = (c.req.query("error") ?? "").trim();
  const state = (c.req.query("state") ?? "").trim();
  const code = (c.req.query("code") ?? "").trim();
  const payload = state ? verifyOAuthState(state, env.hubSecret) : null;
  const connectionHint = payload?.cid;

  if (denied === "access_denied") {
    return c.redirect(oauthErrorUrl("已取消 Notion 授权。", connectionHint), 302);
  }
  if (denied) {
    return c.redirect(oauthErrorUrl("Notion 授权失败，请重试或改用 Integration Token。", connectionHint), 302);
  }
  if (!payload) {
    return c.redirect(oauthErrorUrl("授权状态无效或已过期，请重新点击「用 Notion 登录授权」。"), 302);
  }

  const cookie = c.req.header("cookie") ?? "";
  const m = /(?:^|;\s*)hub_oauth_nonce=([^;]+)/.exec(cookie);
  if (m) {
    const cookieNonce = decodeURIComponent(m[1]);
    if (cookieNonce !== payload.n) {
      return c.redirect(oauthErrorUrl("授权状态无效或已过期，请重新点击「用 Notion 登录授权」。", payload.cid), 302);
    }
  }

  if (!code) {
    return c.redirect(oauthErrorUrl("缺少授权码，请重新点击「用 Notion 登录授权」。", payload.cid), 302);
  }
  if (!notionOAuthEnv.configured) {
    return c.redirect(
      oauthErrorUrl("尚未配置 Notion OAuth。可改用 Integration Token。", payload.cid),
      302,
    );
  }

  const gate = await requireRole(payload.uid, payload.sid, "editor");
  if (!gate.ok) {
    return c.redirect(oauthErrorUrl("没有权限为该空间接入 Notion。"), 302);
  }

  let tokens;
  try {
    tokens = await exchangeNotionAuthorizationCode({
      code,
      clientId: notionOAuthEnv.clientId,
      clientSecret: notionOAuthEnv.clientSecret,
      redirectUri: notionOAuthEnv.redirectUri,
    });
  } catch {
    return c.redirect(oauthErrorUrl("Notion 换票失败，请重试或改用 Integration Token。", payload.cid), 302);
  }

  const workspaceId = tokens.workspace_id || payload.ws || "";
  const name = payload.name || tokens.workspace_name || "我的 Notion";

  try {
    let connId = payload.cid ?? "";
    if (connId) {
      const row = await query<{ id: string; source: string; space_id: string; secrets_ref: string | null; config: Record<string, unknown> }>(
        "SELECT id, source, space_id, secrets_ref, config FROM connections WHERE id = $1",
        [connId],
      );
      const conn = row.rows[0];
      if (!conn || conn.space_id !== payload.sid || conn.source !== "notion") {
        return c.redirect(oauthErrorUrl("连接不存在或不是 Notion。"), 302);
      }
      const existing = await decryptConnectionSecrets(conn);
      const merged = applyNotionOAuthSecrets(existing, tokens);
      const secretsRef = await persistEncryptedSecrets(merged);
      const config = { ...(conn.config ?? {}) };
      if (workspaceId) config.workspace_id = workspaceId;
      await query(
        `UPDATE connections SET secrets_ref = $2, config = $3::jsonb, status = 'active', last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [connId, secretsRef, JSON.stringify(config)],
      );
    } else {
      const secrets: ConnectionSecrets = applyNotionOAuthSecrets(null, tokens);
      const secretsRef = await persistEncryptedSecrets(secrets);
      const config: Record<string, unknown> = {};
      if (workspaceId) config.workspace_id = workspaceId;
      const inserted = await query<{ id: string }>(
        `INSERT INTO connections (space_id, source, name, config, secrets_ref, status, mode)
         VALUES ($1,'notion',$2,$3::jsonb,$4,'active',NULL)
         RETURNING id`,
        [payload.sid, name, JSON.stringify(config), secretsRef],
      );
      connId = inserted.rows[0].id;
    }

    try {
      await enqueueSync(connId);
    } catch {
      /* connection is saved even if enqueue fails */
    }

    c.header("Set-Cookie", nonceCookie("", 0));
    return c.redirect(oauthOkUrl(connId), 302);
  } catch {
    return c.redirect(oauthErrorUrl("保存 Notion 授权失败，请重试。", payload.cid), 302);
  }
});

oauthRoutes.get("/connections/oauth/feishu/status", requireUser, async (c) => {
  return c.json({
    configured: feishuOAuthEnv.configured,
    redirect_uri: feishuOAuthEnv.redirectUri,
  });
});

type AppCtx = Context<{ Variables: Vars }>;
type FeishuStart =
  | { ok: false; res: Response }
  | {
      ok: true;
      client: { clientId: string; clientSecret: string };
      state: string;
      nonce: string;
      redirectUri: string;
      origin: string;
    };

async function startFeishuOAuth(c: AppCtx): Promise<FeishuStart> {
  const user = c.get("user");
  const spaceId = (c.req.query("space_id") ?? "").trim();
  if (!UUID_RE.test(spaceId)) {
    return { ok: false, res: jsonError(c, 400, "invalid_request", "缺少 space_id") };
  }
  const gate = await requireRole(user.id, spaceId, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return { ok: false, res: denied };

  const connectionId = (c.req.query("connection_id") ?? "").trim();
  let stored: ConnectionSecrets | null = null;
  if (connectionId) {
    if (!UUID_RE.test(connectionId)) {
      return { ok: false, res: jsonError(c, 400, "invalid_request", "连接 ID 无效") };
    }
    const row = await query<{ id: string; source: string; space_id: string; secrets_ref: string | null }>(
      "SELECT id, source, space_id, secrets_ref FROM connections WHERE id = $1",
      [connectionId],
    );
    const conn = row.rows[0];
    if (!conn || conn.space_id !== spaceId) return { ok: false, res: errors.notFound(c) };
    if (conn.source !== "feishu") {
      return { ok: false, res: jsonError(c, 400, "invalid_request", "该连接不是飞书") };
    }
    stored = await decryptConnectionSecrets(conn);
  }

  const client = feishuOAuthClient(stored);
  if (!client) {
    return {
      ok: false,
      res: jsonError(
        c,
        400,
        "oauth_not_configured",
        "尚未配置飞书应用（连接里的 App ID/Secret，或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）。",
      ),
    };
  }

  const name = (c.req.query("name") ?? "").trim() || "我的飞书";
  const resolved = resolveOAuthRedirectOrigin(c.req.query("origin"), env.webOrigin);
  if (!resolved.ok) {
    return { ok: false, res: jsonError(c, 400, "invalid_request", "回调来源不允许") };
  }
  const redirectUri = oauthCallbackRedirectUri(resolved.origin, "feishu");
  const { state, nonce } = signOAuthState(
    {
      uid: user.id,
      sid: spaceId,
      cid: connectionId || undefined,
      name,
      origin: resolved.origin,
    },
    env.hubSecret,
  );
  return { ok: true, client, state, nonce, redirectUri, origin: resolved.origin };
}

oauthRoutes.get("/connections/oauth/feishu/authorize", requireUser, async (c) => {
  const started = await startFeishuOAuth(c);
  if (!started.ok) return started.res;
  const url = buildFeishuAuthorizeUrl({
    clientId: started.client.clientId,
    redirectUri: started.redirectUri,
    state: started.state,
  });
  c.header("Set-Cookie", nonceCookie(started.nonce, 600, started.origin.startsWith("https:")));
  return c.json({ url });
});

oauthRoutes.get("/connections/oauth/feishu/qr", requireUser, async (c) => {
  const started = await startFeishuOAuth(c);
  if (!started.ok) return started.res;
  const goto = buildFeishuQrGotoUrl({
    clientId: started.client.clientId,
    redirectUri: started.redirectUri,
    state: started.state,
  });
  c.header("Set-Cookie", nonceCookie(started.nonce, 600, started.origin.startsWith("https:")));
  return c.json({
    client_id: started.client.clientId,
    redirect_uri: started.redirectUri,
    goto,
    state: started.state,
  });
});

oauthRoutes.get("/connections/oauth/feishu/callback", async (c) => {
  const denied = (c.req.query("error") ?? "").trim();
  const state = (c.req.query("state") ?? "").trim();
  const code = (c.req.query("code") ?? "").trim();
  const payload = state ? verifyOAuthState(state, env.hubSecret) : null;
  const connectionHint = payload?.cid;
  const origin = payload?.origin;

  if (denied === "access_denied") {
    return c.redirect(oauthErrorUrl("已取消飞书授权。", connectionHint, "feishu", origin), 302);
  }
  if (denied) {
    return c.redirect(oauthErrorUrl("飞书授权失败，请重新扫码登录。", connectionHint, "feishu", origin), 302);
  }
  if (!payload) {
    return c.redirect(oauthErrorUrl("授权状态无效或已过期，请重新点击「用飞书扫码登录」。", undefined, "feishu"), 302);
  }

  const cookie = c.req.header("cookie") ?? "";
  const m = /(?:^|;\s*)hub_oauth_nonce=([^;]+)/.exec(cookie);
  if (m) {
    const cookieNonce = decodeURIComponent(m[1]);
    if (cookieNonce !== payload.n) {
      return c.redirect(oauthErrorUrl("授权状态无效或已过期，请重新点击「用飞书扫码登录」。", payload.cid, "feishu", origin), 302);
    }
  }

  if (!code) {
    return c.redirect(oauthErrorUrl("缺少授权码，请重新点击「用飞书扫码登录」。", payload.cid, "feishu", origin), 302);
  }

  const gate = await requireRole(payload.uid, payload.sid, "editor");
  if (!gate.ok) {
    return c.redirect(oauthErrorUrl("没有权限为该空间接入飞书。", undefined, "feishu", origin), 302);
  }

  let existingSecrets: ConnectionSecrets | null = null;
  let connRow: { id: string; source: string; space_id: string; secrets_ref: string | null; config: Record<string, unknown> } | undefined;
  if (payload.cid) {
    const row = await query<{ id: string; source: string; space_id: string; secrets_ref: string | null; config: Record<string, unknown> }>(
      "SELECT id, source, space_id, secrets_ref, config FROM connections WHERE id = $1",
      [payload.cid],
    );
    connRow = row.rows[0];
    if (!connRow || connRow.space_id !== payload.sid || connRow.source !== "feishu") {
      return c.redirect(oauthErrorUrl("连接不存在或不是飞书。", undefined, "feishu", origin), 302);
    }
    existingSecrets = await decryptConnectionSecrets(connRow);
  }

  const client = feishuOAuthClient(existingSecrets);
  if (!client) {
    return c.redirect(oauthErrorUrl("尚未配置飞书应用，无法换票。", payload.cid, "feishu", origin), 302);
  }

  let tokens;
  try {
    tokens = await exchangeFeishuAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: oauthCallbackRedirectUri(pageOrigin(origin), "feishu"),
    });
  } catch {
    return c.redirect(oauthErrorUrl("飞书换票失败，请重新扫码登录。", payload.cid, "feishu", origin), 302);
  }

  const name = payload.name || "我的飞书";

  try {
    let connId = payload.cid ?? "";
    if (connId && connRow) {
      const merged = applyFeishuOAuthSecrets(existingSecrets, tokens, client);
      const secretsRef = await persistEncryptedSecrets(merged);
      await query(
        `UPDATE connections SET secrets_ref = $2, status = 'active', last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [connId, secretsRef],
      );
    } else {
      const secrets: ConnectionSecrets = applyFeishuOAuthSecrets(null, tokens, client);
      const secretsRef = await persistEncryptedSecrets(secrets);
      const inserted = await query<{ id: string }>(
        `INSERT INTO connections (space_id, source, name, config, secrets_ref, status, mode)
         VALUES ($1,'feishu',$2,$3::jsonb,$4,'active',NULL)
         RETURNING id`,
        [payload.sid, name, JSON.stringify({ obj_types: ["docx"] }), secretsRef],
      );
      connId = inserted.rows[0].id;
    }

    try {
      await enqueueSync(connId);
    } catch {
      /* connection is saved even if enqueue fails */
    }

    c.header("Set-Cookie", nonceCookie("", 0, pageOrigin(origin).startsWith("https:")));
    return c.redirect(oauthOkUrl(connId, origin), 302);
  } catch {
    return c.redirect(oauthErrorUrl("保存飞书授权失败，请重试。", payload.cid, "feishu", origin), 302);
  }
});

