import { Hono } from "hono";
import {
  createPgHostApi,
  ensureSkillOnSpace,
  isOfficialSkillId,
  isSkillEnabled,
  listOfficialCatalog,
  runOfficialHook,
  setSpaceSkillEnabled,
  upsertOfficialSkillRow,
} from "@note-hub/skills-runtime";
import { query } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const skillRoutes = new Hono<{ Variables: Vars }>();
skillRoutes.use("*", requireUser);

skillRoutes.get("/skills", async (c) => {
  const user = c.get("user");
  const catalog = listOfficialCatalog();
  const installed = await query(
    `SELECT ss.space_id, ss.skill_id, ss.enabled, ss.config, s.version, s.name, s.description, s.hooks, sp.name AS space_name
     FROM space_skills ss
     JOIN skills s ON s.id = ss.skill_id
     JOIN spaces sp ON sp.id = ss.space_id
     JOIN space_members m ON m.space_id = ss.space_id AND m.user_id = $1
     ORDER BY ss.skill_id`,
    [user.id],
  );
  return c.json({ catalog, installed: installed.rows });
});

skillRoutes.post("/spaces/:id/skills/install", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { skill_id?: string; version?: string };
  const skillId = (body.skill_id ?? "").trim();
  if (!isOfficialSkillId(skillId)) {
    return jsonError(c, 404, "not_found", "未知的官方 Skill");
  }
  const manifest = await upsertOfficialSkillRow(query, skillId);
  if (body.version && body.version !== manifest.version) {
    return jsonError(c, 400, "invalid_request", `版本不匹配，仓库中为 ${manifest.version}`);
  }
  const state = await ensureSkillOnSpace(query, spaceId, skillId);
  return c.json({ skill_id: skillId, version: manifest.version, enabled: state.enabled }, 201);
});

skillRoutes.post("/spaces/:id/skills/:skillId/enable", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const skillId = c.req.param("skillId");
  const gate = await requireRole(user.id, spaceId, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return jsonError(c, 400, "invalid_request", "需要 enabled: true|false");
  }
  const ok = await setSpaceSkillEnabled(query, spaceId, skillId, body.enabled);
  if (!ok) return errors.notFound(c, "尚未安装该 Skill");
  return c.json({ skill_id: skillId, enabled: body.enabled });
});

skillRoutes.get("/spaces/:id/meetings", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const r = await query(
    `SELECT a.id, a.space_id, a.skill_id, a.note_id, a.kind, a.payload, a.created_at,
            n.title AS note_title, n.path AS note_path
     FROM skill_artifacts a
     LEFT JOIN notes n ON n.id = a.note_id
       AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)
     WHERE a.space_id = $1 AND a.kind = 'meeting'
     ORDER BY a.created_at DESC LIMIT 200`,
    [spaceId, user.id, gate.mem.role],
  );
  return c.json({ meetings: r.rows });
});

skillRoutes.get("/spaces/:id/writing-health", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const enabled = await isSkillEnabled(query, spaceId, "writing-health");
  if (!enabled) return errors.notFound(c, "尚未启用 writing-health");
  const kindRow = await query<{ kind: string }>("SELECT kind FROM spaces WHERE id = $1", [spaceId]);
  const host = createPgHostApi({ query, spaceId, userId: user.id });
  const result = await runOfficialHook("writing-health", {
    space_id: spaceId,
    space_kind: kindRow.rows[0]?.kind === "team" ? "team" : "personal",
    hook: "weekly-report",
    payload: {},
    host,
  });
  const latest = await query(
    `SELECT id, space_id, skill_id, note_id, kind, payload, created_at
     FROM skill_artifacts
     WHERE space_id = $1 AND kind = 'writing-health-report'
     ORDER BY created_at DESC LIMIT 1`,
    [spaceId],
  );
  return c.json({
    markdown: result.markdown ?? "",
    report: latest.rows[0] ?? null,
    extra: result.extra ?? latest.rows[0]?.payload ?? null,
  });
});
