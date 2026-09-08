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
import { errors, jsonError } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const askRoutes = new Hono<{ Variables: Vars }>();
askRoutes.use("*", requireUser);

const loadChunks = loadChunksViaSql((text, params) => query(text, params));
const loadVectorChunks = loadVectorChunksViaSql((text, params) => query(text, params));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function truncateTitle(q: string, max = 48): string {
  const t = q.trim().replace(/\s+/g, " ");
  if (!t) return "新对话";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type ThreadRow = {
  id: string;
  space_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  mode: string | null;
  created_at: string;
};

async function loadThread(spaceId: string, userId: string, threadId: string) {
  const r = await query<ThreadRow>(
    `SELECT id, space_id, user_id, title, created_at, updated_at
     FROM ask_threads
     WHERE id = $1 AND space_id = $2 AND user_id = $3`,
    [threadId, spaceId, userId],
  );
  return r.rows[0] ?? null;
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

askRoutes.get("/spaces/:id/ask/threads", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  const r = await query<ThreadRow>(
    `SELECT id, space_id, user_id, title, created_at, updated_at
     FROM ask_threads
     WHERE space_id = $1 AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT 100`,
    [spaceId, user.id],
  );
  return c.json({ threads: r.rows });
});

askRoutes.post("/spaces/:id/ask/threads", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  let body: { title?: unknown } = {};
  try {
    body = (await c.req.json()) as { title?: unknown };
  } catch {
    body = {};
  }
  const title =
    typeof body.title === "string" && body.title.trim() ? truncateTitle(body.title) : "新对话";

  const r = await query<ThreadRow>(
    `INSERT INTO ask_threads (space_id, user_id, title)
     VALUES ($1, $2, $3)
     RETURNING id, space_id, user_id, title, created_at, updated_at`,
    [spaceId, user.id, title],
  );
  return c.json({ thread: r.rows[0] }, 201);
});

askRoutes.get("/spaces/:id/ask/threads/:tid/messages", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const threadId = c.req.param("tid");
  if (!isUuid(threadId)) return jsonError(c, 400, "invalid_request", "无效的对话 id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  const thread = await loadThread(spaceId, user.id, threadId);
  if (!thread) return errors.notFound(c, "对话不存在");

  const r = await query<MessageRow>(
    `SELECT id, thread_id, role, content, citations, mode, created_at
     FROM ask_messages
     WHERE thread_id = $1
     ORDER BY created_at ASC, id ASC`,
    [threadId],
  );
  return c.json({ thread, messages: r.rows });
});

askRoutes.delete("/spaces/:id/ask/threads/:tid", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const threadId = c.req.param("tid");
  if (!isUuid(threadId)) return jsonError(c, 400, "invalid_request", "无效的对话 id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  const r = await query(
    `DELETE FROM ask_threads
     WHERE id = $1 AND space_id = $2 AND user_id = $3
     RETURNING id`,
    [threadId, spaceId, user.id],
  );
  if (!r.rowCount) return errors.notFound(c, "对话不存在");
  return c.json({ ok: true });
});

askRoutes.post("/spaces/:id/ask", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  let body: { query?: unknown; q?: unknown; note_ids?: unknown; thread_id?: unknown } = {};
  try {
    body = (await c.req.json()) as {
      query?: unknown;
      q?: unknown;
      note_ids?: unknown;
      thread_id?: unknown;
    };
  } catch {
    body = {};
  }
  const qRaw =
    typeof body.q === "string" ? body.q : typeof body.query === "string" ? body.query : "";
  const q = qRaw;
  const noteIds = Array.isArray(body.note_ids)
    ? body.note_ids.filter((id): id is string => typeof id === "string")
    : undefined;
  const threadIdRaw = typeof body.thread_id === "string" ? body.thread_id.trim() : "";
  if (threadIdRaw && !isUuid(threadIdRaw)) {
    return jsonError(c, 400, "invalid_request", "无效的对话 id");
  }

  let thread: ThreadRow | null = null;
  if (threadIdRaw) {
    thread = await loadThread(spaceId, user.id, threadIdRaw);
    if (!thread) return errors.notFound(c, "对话不存在");
  }

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
        provider: ai.embed_provider,
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

  const persistTurn = async (payload: {
    answer_markdown: string;
    citations: unknown;
    mode: string;
    unknown?: boolean;
  }) => {
    if (!q.trim()) {
      return { thread_id: thread?.id as string | undefined };
    }
    if (!thread) {
      const created = await query<ThreadRow>(
        `INSERT INTO ask_threads (space_id, user_id, title)
         VALUES ($1, $2, $3)
         RETURNING id, space_id, user_id, title, created_at, updated_at`,
        [spaceId, user.id, truncateTitle(q)],
      );
      thread = created.rows[0]!;
    } else if (!thread.title || thread.title === "新对话") {
      await query(`UPDATE ask_threads SET title = $2, updated_at = now() WHERE id = $1`, [
        thread.id,
        truncateTitle(q),
      ]);
      thread = { ...thread, title: truncateTitle(q) };
    } else {
      await query(`UPDATE ask_threads SET updated_at = now() WHERE id = $1`, [thread.id]);
    }

    await query(
      `INSERT INTO ask_messages (thread_id, role, content, citations, mode)
       VALUES ($1, 'user', $2, NULL, NULL)`,
      [thread.id, q],
    );
    await query(
      `INSERT INTO ask_messages (thread_id, role, content, citations, mode)
       VALUES ($1, 'assistant', $2, $3::jsonb, $4)`,
      [
        thread.id,
        payload.answer_markdown,
        JSON.stringify(payload.citations ?? []),
        payload.mode,
      ],
    );
    return { thread_id: thread.id };
  };

  if (retrieved.unknown) {
    const mode = chat ? "ai" : "extractive";
    const persisted = await persistTurn({
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode,
      unknown: true,
    });
    return c.json({
      unknown: true,
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode,
      ai_configured: Boolean(chat),
      ...persisted,
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
    const mode = answer.mode ?? (chat ? "ai" : "extractive");
    const persisted = await persistTurn({
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode,
      unknown: true,
    });
    return c.json({
      unknown: true,
      answer_markdown: UNKNOWN_ANSWER,
      citations: [],
      mode,
      ai_configured: Boolean(chat),
      ...persisted,
    });
  }
  const extras: Record<string, string> = {};
  if (growthSummary) extras.growth = growthSummary;
  if (writingSummary) extras.writing_health = writingSummary;
  const attached = [growthSummary, writingSummary].filter(Boolean).join("\n\n");
  const markdown = attached
    ? `${answer.answer_markdown}\n\n---\n${attached}`
    : answer.answer_markdown;
  const mode = answer.mode ?? (chat ? "ai" : "extractive");
  const persisted = await persistTurn({
    answer_markdown: markdown,
    citations: answer.citations,
    mode,
  });
  return c.json({
    answer_markdown: markdown,
    citations: answer.citations,
    mode,
    ai_configured: Boolean(chat),
    extra: Object.keys(extras).length ? extras : undefined,
    ...persisted,
  });
});
