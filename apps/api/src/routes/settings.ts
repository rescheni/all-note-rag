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
  type EmbedProvider,
} from "@note-hub/core";
import {
  downloadLocalEmbedModel,
  embedModelDir,
  listLocalEmbedModels,
} from "@note-hub/retrieve";
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


/** Pure chat/completions probe against saved Base URL + API Key (no notes retrieval). */
settingsRoutes.post("/settings/ai/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: unknown;
    prompt?: unknown;
  };
  const resolved = await loadAiSettings(query, env.hubSecret);
  const base = resolved.base_url.trim().replace(/\/+$/, "");
  const key = resolved.api_key.trim();
  const model =
    (typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : resolved.chat_model.trim()) || "gpt-4o-mini";
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "用一句话介绍你自己";

  if (!base || !key) {
    return c.json({
      ok: false as const,
      error: "ai_not_configured",
      detail: "请先填写并保存 Base URL 与 API Key",
    });
  }
  if (!/^https?:\/\//i.test(base)) {
    return c.json({
      ok: false as const,
      error: "invalid_request",
      detail: "Base URL 需要 http(s) 地址",
    });
  }

  const url = `${base}/chat/completions`;
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const latency_ms = Date.now() - started;
    const raw = await res.text();
    const snippet = raw.trim().slice(0, 800);

    if (!res.ok) {
      let detail = snippet || `上游返回 HTTP ${res.status}`;
      try {
        const j = JSON.parse(raw) as {
          error?: { message?: string };
          message?: string;
        };
        const m = j?.error?.message || j?.message;
        if (typeof m === "string" && m.trim()) detail = m.trim().slice(0, 400);
      } catch {
        /* keep snippet */
      }
      return c.json({
        ok: false as const,
        error: "upstream_failed",
        status: res.status,
        detail,
        model,
        latency_ms,
      });
    }

    let text = "";
    try {
      const parsed = JSON.parse(raw) as {
        choices?: { message?: { content?: string } }[];
      };
      text = parsed.choices?.[0]?.message?.content?.trim() ?? "";
    } catch {
      return c.json({
        ok: false as const,
        error: "bad_response",
        status: res.status,
        detail: snippet || "上游返回了非 JSON",
        model,
        latency_ms,
      });
    }
    if (!text) {
      return c.json({
        ok: false as const,
        error: "empty_response",
        status: res.status,
        detail: snippet || "上游未返回文本内容",
        model,
        latency_ms,
      });
    }
    return c.json({
      ok: true as const,
      text,
      model,
      latency_ms,
    });
  } catch (e) {
    const latency_ms = Date.now() - started;
    const msg = e instanceof Error ? e.message : String(e);
    const detail = /abort/i.test(msg)
      ? "请求超时，请检查 Base URL 是否可达"
      : msg.slice(0, 240) || "网络错误";
    return c.json({
      ok: false as const,
      error: /abort/i.test(msg) ? "timeout" : "network_failed",
      detail,
      model,
      latency_ms,
    });
  }
});

/** Catalog of downloadable local ONNX embed models + disk status. */
settingsRoutes.get("/settings/ai/local-embed-models", async (c) => {
  const models = listLocalEmbedModels();
  return c.json({
    models,
    model_dir: embedModelDir(),
    note: "更换本地模型后需重新同步以重建向量",
  });
});

function decodeLocalModelId(raw: string): string {
  const s = decodeURIComponent(raw || "").trim();
  // UI may send Xenova--bge-small-zh-v1.5 to avoid path slashes
  if (s.includes("--") && !s.includes("/")) return s.replace(/--/g, "/");
  return s;
}

/** Download by JSON body { id } — preferred (ids contain slashes). */
settingsRoutes.post("/settings/ai/local-embed-models/download", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return jsonError(c, 400, "invalid_request", "缺少模型 id");
  try {
    const status = await downloadLocalEmbedModel(id);
    return c.json({ model: status, model_dir: embedModelDir() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(c, 400, "download_failed", msg.slice(0, 240) || "下载失败");
  }
});

/** Download by path id (use Xenova--name). Matches design :id/download. */
settingsRoutes.post("/settings/ai/local-embed-models/:id/download", async (c) => {
  const id = decodeLocalModelId(c.req.param("id") || "");
  if (!id) return jsonError(c, 400, "invalid_request", "缺少模型 id");
  try {
    const status = await downloadLocalEmbedModel(id);
    return c.json({ model: status, model_dir: embedModelDir() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(c, 400, "download_failed", msg.slice(0, 240) || "下载失败");
  }
});

settingsRoutes.patch("/settings/ai", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    base_url?: unknown;
    api_key?: unknown;
    embedding_model?: unknown;
    chat_model?: unknown;
    embed_provider?: unknown;
  };
  const patch: {
    base_url?: string;
    api_key?: string;
    embedding_model?: string;
    chat_model?: string;
    embed_provider?: EmbedProvider;
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
  if (body.embed_provider === "api" || body.embed_provider === "local") {
    patch.embed_provider = body.embed_provider;
  }
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
