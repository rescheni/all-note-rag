import { Hono } from "hono";
import { query } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import {
  isSpaceRole,
  requireRole,
  requireUser,
  roleDenied,
  type AuthUser,
  type SpaceRole,
} from "../auth.ts";

type Vars = { user: AuthUser };
export const spaceRoutes = new Hono<{ Variables: Vars }>();

spaceRoutes.use("*", requireUser);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function loadSpace(id: string) {
  const r = await query<{
    id: string;
    kind: string;
    name: string;
    owner_user_id: string;
    created_at: string;
    updated_at: string;
  }>("SELECT id, kind, name, owner_user_id, created_at, updated_at FROM spaces WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

async function ownerCount(spaceId: string): Promise<number> {
  const r = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND role = 'owner'",
    [spaceId],
  );
  return r.rows[0]?.n ?? 0;
}

async function memberRow(spaceId: string, userId: string) {
  const r = await query(
    `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
     FROM space_members m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = $1 AND m.user_id = $2`,
    [spaceId, userId],
  );
  return r.rows[0] ?? null;
}

spaceRoutes.get("/spaces", async (c) => {
  const user = c.get("user");
  const r = await query(
    `SELECT s.id, s.kind, s.name, s.owner_user_id, s.created_at, s.updated_at, m.role
     FROM spaces s
     JOIN space_members m ON m.space_id = s.id
     WHERE m.user_id = $1
     ORDER BY s.created_at`,
    [user.id],
  );
  return c.json({ spaces: r.rows });
});

spaceRoutes.post("/spaces", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; kind?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  if (!name) return jsonError(c, 400, "invalid_request", "需要名称");
  if (kind === "personal") {
    return jsonError(c, 400, "invalid_request", "个人空间仅在注册时自动创建");
  }
  if (kind !== "team") return jsonError(c, 400, "invalid_request", "kind 必须为 team");
  const s = await query(
    `INSERT INTO spaces (kind, name, owner_user_id)
     VALUES ('team', $1, $2)
     RETURNING id, kind, name, owner_user_id, created_at, updated_at`,
    [name, user.id],
  );
  const space = s.rows[0];
  await query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [space.id, user.id],
  );
  return c.json({ space, role: "owner" }, 201);
});

spaceRoutes.get("/spaces/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const gate = await requireRole(user.id, id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const space = await loadSpace(id);
  if (!space) return errors.notFound(c);
  return c.json({ space, role: gate.ok ? gate.mem.role : null });
});

spaceRoutes.get("/spaces/:id/members", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const gate = await requireRole(user.id, id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const r = await query(
    `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
     FROM space_members m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = $1
     ORDER BY m.created_at`,
    [id],
  );
  return c.json({ members: r.rows });
});

spaceRoutes.post("/spaces/:id/members", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const gate = await requireRole(user.id, id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const space = await loadSpace(id);
  if (!space) return errors.notFound(c);
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const roleRaw = typeof body.role === "string" ? body.role.trim() : "";
  if (!email || !email.includes("@")) return jsonError(c, 400, "invalid_request", "需要已注册用户的邮箱");
  if (!isSpaceRole(roleRaw)) return jsonError(c, 400, "invalid_request", "role 必须是 owner、editor 或 viewer");
  const role: SpaceRole = roleRaw;
  if (space.kind === "personal") {
    return jsonError(c, 400, "invalid_request", "个人空间不能添加其他成员");
  }
  const u = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  const target = u.rows[0];
  if (!target) return errors.notFound(c, "用户未注册");
  const existing = await query(
    "SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2",
    [id, target.id],
  );
  if ((existing.rowCount ?? 0) > 0) return jsonError(c, 409, "conflict", "该用户已是成员");
  await query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)`,
    [id, target.id, role],
  );
  return c.json({ member: await memberRow(id, target.id) }, 201);
});

spaceRoutes.put("/spaces/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  if (!isUuid(userId)) return errors.notFound(c);
  const gate = await requireRole(user.id, id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const space = await loadSpace(id);
  if (!space) return errors.notFound(c);
  const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
  const roleRaw = typeof body.role === "string" ? body.role.trim() : "";
  if (!isSpaceRole(roleRaw)) return jsonError(c, 400, "invalid_request", "role 必须是 owner、editor 或 viewer");
  const role: SpaceRole = roleRaw;
  const targetUser = await query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!targetUser.rows[0]) return errors.notFound(c);
  const current = await query<{ role: SpaceRole }>(
    "SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2",
    [id, userId],
  );
  const existing = current.rows[0];
  if (!existing) {
    if (space.kind === "personal") {
      return jsonError(c, 400, "invalid_request", "个人空间不能添加其他成员");
    }
    await query(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)`,
      [id, userId, role],
    );
    return c.json({ member: await memberRow(id, userId) });
  }
  if (existing.role === "owner" && role !== "owner" && (await ownerCount(id)) <= 1) {
    return jsonError(c, 400, "invalid_request", "不能降级最后一位所有者");
  }
  await query(
    "UPDATE space_members SET role = $3 WHERE space_id = $1 AND user_id = $2",
    [id, userId, role],
  );
  return c.json({ member: await memberRow(id, userId) });
});

spaceRoutes.delete("/spaces/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  if (!isUuid(userId)) return errors.notFound(c);
  const gate = await requireRole(user.id, id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const current = await query<{ role: SpaceRole }>(
    "SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2",
    [id, userId],
  );
  const existing = current.rows[0];
  if (!existing) return errors.notFound(c);
  if (existing.role === "owner" && (await ownerCount(id)) <= 1) {
    return jsonError(c, 400, "invalid_request", "不能移除最后一位所有者");
  }
  await query("DELETE FROM space_members WHERE space_id = $1 AND user_id = $2", [id, userId]);
  return c.json({ ok: true });
});
