import { Hono } from "hono";
import {
  composeAskAnswer,
  hybridRetrieve,
  loadChunksViaSql,
  UNKNOWN_ANSWER,
} from "@note-hub/retrieve";
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

  const retrieved = await hybridRetrieve(spaceId, q, { noteIds, loadChunks });
  if (retrieved.unknown) {
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
  }
  const answer = await composeAskAnswer(q, retrieved.hits, chatConfig());
  if (answer.unknown) {
    return c.json({ unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] });
  }
  return c.json({
    answer_markdown: answer.answer_markdown,
    citations: answer.citations,
  });
});
