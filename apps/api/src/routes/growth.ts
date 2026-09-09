import { Hono } from "hono";
import {
  ChatUpstreamError,
  composeGrowthAiReport,
  growthAiFailure,
  shortAiError,
  type GrowthAiNote,
} from "@note-hub/retrieve";
import { loadAiSettings } from "@note-hub/core";
import {
  GROWTH_KINDS,
  createPgHostApi,
  ensureSkillOnSpace,
  filterExcludedGrowth,
  growthAccessError,
  lastSevenDayRange,
  noteMatchesExclude,
  parseStringList,
  runOfficialHook,
  type GrowthKind,
} from "@note-hub/skills-runtime";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { loadMembership, requireRole, requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const growthRoutes = new Hono<{ Variables: Vars }>();
growthRoutes.use("*", requireUser);

type PersonalOwner =
  | { ok: false; error: "not_found" | "forbidden" }
  | { ok: false; error: "growth"; growthErr: NonNullable<ReturnType<typeof growthAccessError>> }
  | { ok: true; space: { kind: string; owner_user_id: string }; mem: NonNullable<Awaited<ReturnType<typeof loadMembership>>> };

type IncludedNote = { id: string; title: string; path: string };

async function loadPersonalOwner(userId: string, spaceId: string): Promise<PersonalOwner> {
  const gate = await requireRole(userId, spaceId, "viewer");
  if (!gate.ok) return { ok: false, error: "not_found" };
  const r = await query<{ kind: string; owner_user_id: string }>(
    "SELECT kind, owner_user_id FROM spaces WHERE id = $1",
    [spaceId],
  );
  const space = r.rows[0];
  if (!space) return { ok: false, error: "not_found" };
  const growthErr = growthAccessError(space.kind);
  if (growthErr) return { ok: false, error: "growth", growthErr };
  if (gate.mem.role !== "owner") return { ok: false, error: "forbidden" };
  return { ok: true, space, mem: gate.mem };
}

function reportParams(c: { req: { query: (k: string) => string | undefined } }, body?: Record<string, unknown>) {
  const range = lastSevenDayRange();
  const from =
    (typeof body?.from === "string" && body.from) ||
    c.req.query("from") ||
    range.from;
  const to =
    (typeof body?.to === "string" && body.to) ||
    c.req.query("to") ||
    range.to;
  const exclude_ids = parseStringList(
    body?.exclude_ids ?? body?.excludeIds ?? c.req.query("exclude_ids") ?? c.req.query("exclude"),
  );
  const exclude_paths = parseStringList(
    body?.exclude_paths ?? body?.excludePaths ?? c.req.query("exclude_paths") ?? c.req.query("exclude_path"),
  );
  return { from, to, exclude_ids, exclude_paths };
}

function asIncludedNotes(raw: unknown): IncludedNote[] {
  if (!Array.isArray(raw)) return [];
  const out: IncludedNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    out.push({
      id: row.id,
      title: typeof row.title === "string" ? row.title : row.id,
      path: typeof row.path === "string" ? row.path : "",
    });
  }
  return out;
}

async function runGrowthReport(
  userId: string,
  spaceId: string,
  params: { from: string; to: string; exclude_ids: string[]; exclude_paths: string[] },
) {
  await ensureSkillOnSpace(query, spaceId, "growth-weekly");
  const host = createPgHostApi({ query, spaceId, userId });
  const result = await runOfficialHook("growth-weekly", {
    space_id: spaceId,
    space_kind: "personal",
    hook: "weekly-report",
    payload: {
      from: params.from,
      to: params.to,
      exclude_ids: params.exclude_ids,
      exclude_paths: params.exclude_paths,
    },
    host,
  });
  const latest = await query(
    `SELECT id, space_id, range_from, range_to, markdown, created_at
     FROM growth_reports WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [spaceId],
  );
  let included_notes = asIncludedNotes(result.extra?.included_notes);
  if (!included_notes.length) {
    included_notes = await loadIncludedNotes(userId, spaceId, params);
  }
  return {
    from: params.from,
    to: params.to,
    exclude_ids: params.exclude_ids,
    exclude_paths: params.exclude_paths,
    markdown: result.markdown ?? latest.rows[0]?.markdown ?? "",
    report: latest.rows[0] ?? null,
    included_notes,
    mode: "template" as const,
  };
}

async function loadIncludedNotes(
  userId: string,
  spaceId: string,
  params: { from: string; to: string; exclude_ids: string[]; exclude_paths: string[] },
): Promise<IncludedNote[]> {
  const host = createPgHostApi({ query, spaceId, userId });
  const events = await host.queryGrowth({ from: params.from, to: params.to });
  const ids = [...new Set(events.map((e) => e.note_id).filter((id): id is string => Boolean(id)))];
  const notes = ids.length ? await host.queryNotes({ ids }) : [];
  const filtered = filterExcludedGrowth(events, notes, params.exclude_ids, params.exclude_paths);
  return filtered.notes.map((n) => ({ id: n.id, title: n.title, path: n.path }));
}

async function loadNotesForAi(
  userId: string,
  spaceId: string,
  params: { from: string; to: string; exclude_ids: string[]; exclude_paths: string[] },
  noteIds: string[] | undefined,
): Promise<GrowthAiNote[]> {
  const host = createPgHostApi({ query, spaceId, userId });
  const idSet = new Set(params.exclude_ids);
  if (noteIds?.length) {
    const notes = await host.queryNotes({ ids: noteIds });
    return notes
      .filter((n) => !noteMatchesExclude(n, n.id, idSet, params.exclude_paths))
      .map((n) => ({ id: n.id, title: n.title, path: n.path, markdown: n.markdown }));
  }
  const events = await host.queryGrowth({ from: params.from, to: params.to });
  const ids = [...new Set(events.map((e) => e.note_id).filter((id): id is string => Boolean(id)))];
  const notes = ids.length ? await host.queryNotes({ ids }) : [];
  const filtered = filterExcludedGrowth(events, notes, params.exclude_ids, params.exclude_paths);
  return filtered.notes.map((n) => ({
    id: n.id,
    title: n.title,
    path: n.path,
    markdown: n.markdown,
  }));
}

growthRoutes.get("/spaces/:id/growth/report", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const loaded = await loadPersonalOwner(user.id, spaceId);
  if (!loaded.ok && loaded.error === "not_found") return errors.notFound(c);
  if (!loaded.ok && loaded.error === "forbidden") return errors.forbidden(c);
  if (!loaded.ok && loaded.error === "growth") {
    return jsonError(c, 400, loaded.growthErr.code, loaded.growthErr.message);
  }
  const params = reportParams(c);
  const out = await runGrowthReport(user.id, spaceId, params);
  return c.json(out);
});

growthRoutes.post("/spaces/:id/growth/report", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const loaded = await loadPersonalOwner(user.id, spaceId);
  if (!loaded.ok && loaded.error === "not_found") return errors.notFound(c);
  if (!loaded.ok && loaded.error === "forbidden") return errors.forbidden(c);
  if (!loaded.ok && loaded.error === "growth") {
    return jsonError(c, 400, loaded.growthErr.code, loaded.growthErr.message);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const params = reportParams(c, body);
  const wantAi = body.ai === true || body.ai === "true" || body.mode === "ai";

  if (!wantAi) {
    const out = await runGrowthReport(user.id, spaceId, params);
    return c.json(out);
  }

  // AI path — soft-fail to draft; never 500 on upstream chat errors.
  let draftMarkdown =
    typeof body.draft_markdown === "string"
      ? body.draft_markdown
      : typeof body.draftMarkdown === "string"
        ? body.draftMarkdown
        : "";
  let included_notes: IncludedNote[] = [];
  if (!draftMarkdown.trim()) {
    const draft = await runGrowthReport(user.id, spaceId, params);
    draftMarkdown = draft.markdown;
    included_notes = draft.included_notes;
  } else {
    included_notes = await loadIncludedNotes(user.id, spaceId, params);
  }

  const noteIdsRaw = body.note_ids ?? body.noteIds;
  const note_ids = Array.isArray(noteIdsRaw)
    ? noteIdsRaw.filter((id): id is string => typeof id === "string" && Boolean(id))
    : undefined;

  const ai = await loadAiSettings(query, env.hubSecret);
  const chat = ai.configured
    ? { baseUrl: ai.base_url, apiKey: ai.api_key, model: ai.chat_model }
    : undefined;

  if (!chat) {
    return c.json({
      from: params.from,
      to: params.to,
      exclude_ids: params.exclude_ids,
      exclude_paths: params.exclude_paths,
      markdown: draftMarkdown,
      draft_markdown: draftMarkdown,
      included_notes,
      mode: "ai",
      ai_failed: true,
      ai_error: "未配置 AI（请到设置填写 Base URL 与 API Key）",
      ai_configured: false,
    });
  }

  const notesForAi = await loadNotesForAi(user.id, spaceId, params, note_ids);
  try {
    const markdown = await composeGrowthAiReport(draftMarkdown, notesForAi, chat);
    const host = createPgHostApi({ query, spaceId, userId: user.id });
    await host.writeReport({
      range_from: params.from,
      range_to: params.to,
      markdown,
    });
    const latest = await query(
      `SELECT id, space_id, range_from, range_to, markdown, created_at
       FROM growth_reports WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    return c.json({
      from: params.from,
      to: params.to,
      exclude_ids: params.exclude_ids,
      exclude_paths: params.exclude_paths,
      markdown,
      draft_markdown: draftMarkdown,
      included_notes,
      note_ids: notesForAi.map((n) => n.id),
      mode: "ai",
      ai_configured: true,
      report: latest.rows[0] ?? null,
    });
  } catch (e) {
    if (e instanceof ChatUpstreamError) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "growth ai report failed; returning draft",
          code: e.code,
          error: e.message,
          status: e.status,
        }),
      );
      const failed = growthAiFailure(draftMarkdown, e);
      return c.json({
        from: params.from,
        to: params.to,
        exclude_ids: params.exclude_ids,
        exclude_paths: params.exclude_paths,
        markdown: failed.markdown,
        draft_markdown: draftMarkdown,
        included_notes,
        mode: "ai",
        ai_failed: true,
        ai_error: failed.ai_error ?? shortAiError(e),
        ai_configured: true,
      });
    }
    console.error(
      JSON.stringify({
        level: "error",
        message: "growth ai report unexpected error; returning draft",
        error: String(e),
      }),
    );
    const failed = growthAiFailure(draftMarkdown, e);
    return c.json({
      from: params.from,
      to: params.to,
      exclude_ids: params.exclude_ids,
      exclude_paths: params.exclude_paths,
      markdown: failed.markdown,
      draft_markdown: draftMarkdown,
      included_notes,
      mode: "ai",
      ai_failed: true,
      ai_error: failed.ai_error,
      ai_configured: true,
    });
  }
});

growthRoutes.get("/spaces/:id/growth", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const loaded = await loadPersonalOwner(user.id, spaceId);
  if (!loaded.ok && loaded.error === "not_found") return errors.notFound(c);
  if (!loaded.ok && loaded.error === "forbidden") return errors.forbidden(c);
  if (!loaded.ok && loaded.error === "growth") {
    return jsonError(c, 400, loaded.growthErr.code, loaded.growthErr.message);
  }
  await ensureSkillOnSpace(query, spaceId, "growth-weekly");
  const kind = c.req.query("kind");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const params: unknown[] = [spaceId];
  let sql = `SELECT g.id, g.space_id, g.user_id, g.note_id, g.kind, g.happened_at, g.payload, g.created_at,
                    n.title AS note_title, n.path AS note_path
             FROM growth_events g
             JOIN spaces s ON s.id = g.space_id AND s.kind = 'personal'
             LEFT JOIN notes n ON n.id = g.note_id
             WHERE g.space_id = $1`;
  if (kind) {
    params.push(kind);
    sql += ` AND g.kind = $${params.length}`;
  }
  if (from) {
    params.push(from);
    sql += ` AND g.happened_at >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    sql += ` AND g.happened_at < ($${params.length}::date + interval '1 day')`;
  }
  sql += " ORDER BY g.happened_at DESC LIMIT 200";
  const r = await query(sql, params);
  return c.json({ events: r.rows });
});

growthRoutes.post("/spaces/:id/growth", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const loaded = await loadPersonalOwner(user.id, spaceId);
  if (!loaded.ok && loaded.error === "not_found") return errors.notFound(c);
  if (!loaded.ok && loaded.error === "forbidden") return errors.forbidden(c);
  if (!loaded.ok && loaded.error === "growth") {
    return jsonError(c, 400, loaded.growthErr.code, loaded.growthErr.message);
  }
  await ensureSkillOnSpace(query, spaceId, "growth-weekly");
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: string;
    happened_at?: string;
    payload?: Record<string, unknown>;
    note_id?: string | null;
  };
  const kind = body.kind as GrowthKind | undefined;
  if (!kind || !GROWTH_KINDS.includes(kind)) {
    return jsonError(c, 400, "invalid_request", "kind 必须是 goal / habit / mood / review / focus");
  }
  const happened_at = body.happened_at || new Date().toISOString();
  const host = createPgHostApi({ query, spaceId, userId: user.id });
  const written = await host.writeGrowthEvent({
    kind,
    happened_at,
    payload: body.payload ?? {},
    note_id: body.note_id ?? null,
  });
  const row = await query("SELECT * FROM growth_events WHERE id = $1", [written.id]);
  return c.json({ event: row.rows[0], created: written.created }, written.created ? 201 : 200);
});
