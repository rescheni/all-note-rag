import { Hono } from "hono";
import {
  ambientPatchFrom,
  loadAiSettings,
  loadAmbientSettings,
  loadThemeSettings,
  publicAiSettings,
  saveAiSettings,
  saveAmbientSettings,
  saveThemeSettings,
  themePatchFrom,
} from "@note-hub/core";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { jsonError } from "../errors.ts";
import { requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const settingsRoutes = new Hono<{ Variables: Vars }>();
settingsRoutes.use("*", requireUser);

settingsRoutes.get("/settings/ai", async (c) => {
  const resolved = await loadAiSettings(query, env.hubSecret);
  return c.json(publicAiSettings(resolved));
});

/** Proxy OpenAI-compatible GET {base_url}/models using stored credentials. */
settingsRoutes.get("/settings/ai/models", async (c) => {
  const resolved = await loadAiSettings(query, env.hubSecret);
  const base = resolved.base_url.trim().replace(/\/+$/, "");
  const key = resolved.api_key.trim();
  if (!base || !key) {
    return jsonError(
      c,
      400,
      "ai_not_configured",
      "请先填写并保存 Base URL 与 API Key，再刷新模型列表",
    );
  }
  if (!/^https?:\/\//i.test(base)) {
    return jsonError(c, 400, "invalid_request", "Base URL 需要 http(s) 地址");
  }
  const url = `${base}/models`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const raw = await res.text();
    if (!res.ok) {
      let detail = `上游返回 ${res.status}`;
      try {
        const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
        const m = j?.error?.message || j?.message;
        if (typeof m === "string" && m.trim()) detail = m.trim().slice(0, 200);
      } catch {
        /* ignore */
      }
      return jsonError(c, 400, "models_fetch_failed", `拉取模型列表失败：${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError(c, 400, "models_fetch_failed", "拉取模型列表失败：上游返回了非 JSON");
    }
    const rows = Array.isArray((parsed as { data?: unknown })?.data)
      ? ((parsed as { data: unknown[] }).data)
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;
    if (!rows) {
      return jsonError(c, 400, "models_fetch_failed", "拉取模型列表失败：响应格式无法识别");
    }
    const data: { id: string; owned_by?: string }[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id.trim() : "";
      if (!id) continue;
      const owned =
        typeof (row as { owned_by?: unknown }).owned_by === "string"
          ? (row as { owned_by: string }).owned_by.trim()
          : undefined;
      data.push(owned ? { id, owned_by: owned } : { id });
    }
    data.sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /abort/i.test(msg)
      ? "请求超时，请检查 Base URL 是否可达"
      : msg.slice(0, 160) || "网络错误";
    return jsonError(c, 400, "models_fetch_failed", `拉取模型列表失败：${friendly}`);
  }
});

settingsRoutes.patch("/settings/ai", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    base_url?: unknown;
    api_key?: unknown;
    embedding_model?: unknown;
    chat_model?: unknown;
  };
  const patch: {
    base_url?: string;
    api_key?: string;
    embedding_model?: string;
    chat_model?: string;
  } = {};
  if (typeof body.base_url === "string") {
    const u = body.base_url.trim();
    if (u && !/^https?:\/\//i.test(u)) {
      return jsonError(c, 400, "invalid_request", "Base URL 需要 http(s) 地址");
    }
    patch.base_url = u;
  }
  if (typeof body.api_key === "string") patch.api_key = body.api_key;
  if (typeof body.embedding_model === "string") patch.embedding_model = body.embedding_model;
  if (typeof body.chat_model === "string") patch.chat_model = body.chat_model;
  const saved = await saveAiSettings(query, env.hubSecret, patch);
  return c.json(publicAiSettings(saved));
});

settingsRoutes.get("/settings/ambient", async (c) => {
  const user = c.get("user");
  return c.json(await loadAmbientSettings(query, user.id));
});

settingsRoutes.patch("/settings/ambient", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const patch = ambientPatchFrom(body);
  if (Object.keys(patch).length === 0) {
    return jsonError(c, 400, "invalid_request", "没有可保存的待机特效设置");
  }
  return c.json(await saveAmbientSettings(query, user.id, patch));
});

settingsRoutes.get("/settings/theme", async (c) => {
  const user = c.get("user");
  return c.json(await loadThemeSettings(query, user.id));
});

settingsRoutes.patch("/settings/theme", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const patch = themePatchFrom(body);
  if (Object.keys(patch).length === 0) {
    return jsonError(c, 400, "invalid_request", "没有可保存的主题设置");
  }
  return c.json(await saveThemeSettings(query, user.id, patch));
});

