import { Hono } from "hono";
import {
  ensureSkillOnSpace,
  listOfficialCatalog,
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
  if (skillId !== "growth-weekly") {
    return jsonError(c, 404, "not_found", "P1 仅支持官方 growth-weekly");
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
