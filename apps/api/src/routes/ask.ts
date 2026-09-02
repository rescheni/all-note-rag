import { Hono } from "hono";
import {
  composeAskAnswer,
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
import { errors } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const askRoutes = new Hono<{ Variables: Vars }>();
askRoutes.use("*", requireUser);

const loadChunks = loadChunksViaSql((text, params) => query(text, params));
const loadVectorChunks = loadVectorChunksViaSql((text, params) => query(text, params));


async function chatConfig() {
  const ai = await loadAiSettings(query, env.hubSecret);
  if (!ai.configured) return undefined;
  return { baseUrl: ai.base_url, apiKey: ai.api_key, model: ai.chat_model };
}

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

  let queryEmbedding: number[] | undefined;
  if (q.trim()) {
    try {
      const ai = await loadAiSettings(query, env.hubSecret);
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
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
  }
  const answer = await composeAskAnswer(q, retrieved.hits, await chatConfig());
  if (answer.unknown) {
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
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
    extra: Object.keys(extras).length ? extras : undefined,
  });
});
