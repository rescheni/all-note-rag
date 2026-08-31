import { Hono } from "hono";
import {
  composeAskAnswer,
  hybridRetrieve,
  loadChunksViaSql,
  UNKNOWN_ANSWER,
} from "@note-hub/retrieve";
import {
  createPgHostApi,
  isSkillEnabled,
  runOfficialHook,
} from "@note-hub/skills-runtime";
import { query } from "../db.ts";
import { errors } from "../errors.ts";
import { loadMembership, requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const askRoutes = new Hono<{ Variables: Vars }>();
askRoutes.use("*", requireUser);

const loadChunks = loadChunksViaSql((text, params) => query(text, params));

function chatConfig() {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.CHAT_MODEL?.trim() || "gpt-4o-mini";
  if (!baseUrl || !apiKey) return undefined;
  return { baseUrl, apiKey, model };
}

async function growthOnAsk(spaceId: string, userId: string, q: string): Promise<string | undefined> {
  try {
    const space = await query<{ kind: string }>("SELECT kind FROM spaces WHERE id = $1", [spaceId]);
    if (space.rows[0]?.kind !== "personal") return undefined;
    if (!(await isSkillEnabled(query, spaceId, "growth-weekly"))) return undefined;
    const host = createPgHostApi({ query, spaceId, userId });
    const result = await runOfficialHook("growth-weekly", {
      space_id: spaceId,
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

askRoutes.post("/spaces/:id/ask", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  if (!(await loadMembership(user.id, spaceId))) return errors.notFound(c);

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

  const [retrieved, growthSummary] = await Promise.all([
    hybridRetrieve(spaceId, q, { noteIds, loadChunks }),
    growthOnAsk(spaceId, user.id, q),
  ]);
  if (retrieved.unknown) {
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
  }
  const answer = await composeAskAnswer(q, retrieved.hits, chatConfig());
  if (answer.unknown) {
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
  }
  const markdown = growthSummary
    ? `${answer.answer_markdown}\n\n---\n${growthSummary}`
    : answer.answer_markdown;
  return c.json({
    answer_markdown: markdown,
    citations: answer.citations,
  });
});
