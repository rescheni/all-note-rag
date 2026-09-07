import { Hono } from "hono";
import {
  GROWTH_KINDS,
  createPgHostApi,
  ensureSkillOnSpace,
  growthAccessError,
  lastSevenDayRange,
  parseStringList,
  runOfficialHook,
  type GrowthKind,
} from "@note-hub/skills-runtime";
import { query } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import { loadMembership, requireRole, requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const growthRoutes = new Hono<{ Variables: Vars }>();
growthRoutes.use("*", requireUser);

type PersonalOwner =
  | { ok: false; error: "not_found" | "forbidden" }
  | { ok: false; error: "growth"; growthErr: NonNullable<ReturnType<typeof growthAccessError>> }
  | { ok: true; space: { kind: string; owner_user_id: string }; mem: NonNullable<Awaited<ReturnType<typeof loadMembership>>> };

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
  return {
    from: params.from,
    to: params.to,
    exclude_ids: params.exclude_ids,
    exclude_paths: params.exclude_paths,
    markdown: result.markdown ?? latest.rows[0]?.markdown ?? "",
    report: latest.rows[0] ?? null,
  };
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
  const out = await runGrowthReport(user.id, spaceId, params);
  return c.json(out);
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
