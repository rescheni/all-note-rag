import { Hono } from "hono";
import {
  applyNotionOAuthSecrets,
  buildNotionAuthorizeUrl,
  exchangeNotionAuthorizationCode,
} from "@note-hub/adapters";
import { signOAuthState, verifyOAuthState, type ConnectionSecrets } from "@note-hub/core";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { persistEncryptedSecrets, decryptConnectionSecrets } from "../connection-util.ts";
import { query } from "../db.ts";
import { env, notionOAuthEnv } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { enqueueSync } from "../queue.ts";

type Vars = { user: AuthUser };
export const oauthRoutes = new Hono<{ Variables: Vars }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function webRedirect(path: string): string {
  const origin = env.webOrigin.replace(/\/$/, "");
  return origin + (path.startsWith("/") ? path : `/${path}`);
}

function oauthErrorUrl(message: string, connectionId?: string): string {
  const q = new URLSearchParams({ oauth_error: message });
  if (connectionId && UUID_RE.test(connectionId)) {
    return webRedirect(`/connections/${connectionId}?${q.toString()}`);
  }
  q.set("source", "notion");
  return webRedirect(`/connections/new?${q.toString()}`);
}

function oauthOkUrl(connectionId: string): string {
  return webRedirect(`/connections/${connectionId}?oauth=ok`);
}

function nonceCookie(nonce: string, maxAge: number): string {
  return `hub_oauth_nonce=${encodeURIComponent(nonce)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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
