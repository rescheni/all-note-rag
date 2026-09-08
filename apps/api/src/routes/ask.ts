import { Hono } from "hono";
import {
  ChatUpstreamError,
  composeAskAnswer,
  composeExtractiveAnswer,
  embedTexts,
  hybridRetrieve,
  loadChunksViaSql,
  loadVectorChunksViaSql,
  UNKNOWN_ANSWER,
} from "@note-hub/retrieve";
import {
  createPgHostApi,
  isSkillEnabled,
  runOfficialHook,
} from "@note-hub/skills-runtime";
import { loadAiSettings } from "@note-hub/core";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { jsonError } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const askRoutes = new Hono<{ Variables: Vars }>();
askRoutes.use("*", requireUser);

const loadChunks = loadChunksViaSql((text, params) => query(text, params));
const loadVectorChunks = loadVectorChunksViaSql((text, params) => query(text, params));

async function growthOnAsk(spaceId: string, userId: string, q: string): Promise<string | undefined> {
  try {
    const space = await query<{ kind: string }>("SELECT kind FROM spaces WHERE id = $1", [spaceId]);
    if (space.rows[0]?.kind !== "personal") return undefined;
    if (!(await isSkillEnabled(query, spaceId, "growth-weekly"))) return undefined;
    const host = createPgHostApi({ query, spaceId, userId });
    const result = await runOfficialHook("growth-weekly", {
      space_id: spaceId,
      space_kind: "personal",
      hook: "on-ask",
      payload: { query: q },
      host,
    });
    return result.summary;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "on-ask growth failed", error: String(e) }));
    return undefined;
  }
}

async function writingHealthOnAsk(spaceId: string, userId: string, q: string): Promise<string | undefined> {
  try {
    if (!(await isSkillEnabled(query, spaceId, "writing-health"))) return undefined;
    const host = createPgHostApi({ query, spaceId, userId });
    const kindRow = await query<{ kind: string }>("SELECT kind FROM spaces WHERE id = $1", [spaceId]);
    const result = await runOfficialHook("writing-health", {
      space_id: spaceId,
      space_kind: kindRow.rows[0]?.kind === "team" ? "team" : "personal",
      hook: "on-ask",
      payload: { query: q },
      host,
    });
    return result.summary;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "on-ask writing-health failed", error: String(e) }));
    return undefined;
  }
}

askRoutes.post("/spaces/:id/ask", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  let body: { query?: unknown; note_ids?: unknown } = {};
  try {
    body = (await c.req.json()) as { query?: unknown; note_ids?: unknown };
  } catch {
    body = {};
  }
  const q = typeof body.query === "string" ? body.query : "";
  const noteIds = Array.isArray(body.note_ids)
    ? body.note_ids.filter((id): id is string => typeof id === "string")
    : undefined;

  const ai = await loadAiSettings(query, env.hubSecret);
  const chat = ai.configured
    ? { baseUrl: ai.base_url, apiKey: ai.api_key, model: ai.chat_model }
    : undefined;

  let queryEmbedding: number[] | undefined;
  if (q.trim()) {
    try {
      const [emb] = await embedTexts([q], {
        baseUrl: ai.base_url,
        apiKey: ai.api_key,
        model: ai.embedding_model,
      });
      queryEmbedding = emb;
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: "embed query failed", error: String(e) }));
    }
  }
  const [retrieved, growthSummary, writingSummary] = await Promise.all([
    hybridRetrieve(spaceId, q, {
      noteIds,
      loadChunks,
      loadVectorChunks,
      queryEmbedding,
      userId: user.id,
      role: gate.mem.role,
    }),
    growthOnAsk(spaceId, user.id, q),
    writingHealthOnAsk(spaceId, user.id, q),
  ]);
  if (retrieved.unknown) {
    return c.json({
      unknown: true,
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode: chat ? "ai" : "extractive",
      ai_configured: Boolean(chat),
    });
  }

  let answer;
  try {
    answer = chat
      ? await composeAskAnswer(q, retrieved.hits, chat)
      : composeExtractiveAnswer(q, retrieved.hits);
  } catch (e) {
    if (e instanceof ChatUpstreamError) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "ask chat upstream failed",
          code: e.code,
          error: e.message,
          status: e.status,
        }),
      );
      const status = e.status === 401 || e.status === 403 ? 400 : 502;
      return jsonError(c, status as 400 | 502, e.code, e.message);
    }
    throw e;
  }

  if (answer.unknown) {
    return c.json({
      unknown: true,
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode: answer.mode ?? (chat ? "ai" : "extractive"),
      ai_configured: Boolean(chat),
    });
  }
  const extras: Record<string, string> = {};
  if (growthSummary) extras.growth = growthSummary;
  if (writingSummary) extras.writing_health = writingSummary;
  const attached = [growthSummary, writingSummary].filter(Boolean).join("\n\n");
  const markdown = attached
    ? `${answer.answer_markdown}\n\n---\n${attached}`
    : answer.answer_markdown;
  return c.json({
    answer_markdown: markdown,
    citations: answer.citations,
    mode: answer.mode ?? (chat ? "ai" : "extractive"),
    ai_configured: Boolean(chat),
    extra: Object.keys(extras).length ? extras : undefined,
  });
});
