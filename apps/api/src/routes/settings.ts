import { Hono } from "hono";
import { loadAiSettings, publicAiSettings, saveAiSettings } from "@note-hub/core";
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
