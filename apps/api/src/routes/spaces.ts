import { Hono } from "hono";
import {
  buildActivityRange,
  buildActivitySeries,
  groupActivityByYear,
  isYmd,
  shanghaiYmd,
} from "@note-hub/core";
import { query } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import {
  hashPassword,
  isSpaceRole,
  requireRole,
  requireUser,
  roleDenied,
  type AuthUser,
  type SpaceRole,
} from "../auth.ts";
import { createUser } from "./auth.ts";

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


spaceRoutes.post("/spaces/:id/accounts", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const gate = await requireRole(user.id, id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const space = await loadSpace(id);
  if (!space) return errors.notFound(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: unknown;
    password?: unknown;
    display_name?: unknown;
    role?: unknown;
  };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const display_name = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const roleRaw = typeof body.role === "string" ? body.role.trim() : "viewer";
  if (!email || !email.includes("@")) return jsonError(c, 400, "invalid_request", "需要有效邮箱");
  if (password.length < 6) return jsonError(c, 400, "invalid_request", "密码至少 6 位");
  if (!isSpaceRole(roleRaw)) return jsonError(c, 400, "invalid_request", "role 必须是 owner、editor 或 viewer");
  const role: SpaceRole = roleRaw;

  const existingUser = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  let targetId: string;
  let createdUser: Record<string, unknown> | null = null;

  if (existingUser.rows[0]) {
    targetId = existingUser.rows[0].id;
    const already = await query(
      "SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2",
      [id, targetId],
    );
    if ((already.rowCount ?? 0) > 0) {
      return jsonError(c, 409, "conflict", "该用户已是成员");
    }
    return jsonError(c, 409, "conflict", "该邮箱已注册，请用「添加成员」邀请已有账号");
  } else {
    const out = await createUser({
      email,
      password,
      display_name: display_name || undefined,
      withPersonalSpace: false,
    });
    targetId = out.user.id;
    createdUser = out.user as unknown as Record<string, unknown>;
  }

  await query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)`,
    [id, targetId, role],
  );
  const member = await memberRow(id, targetId);
  return c.json({ user: createdUser, member }, 201);
});

spaceRoutes.put("/spaces/:id/accounts/:userId/password", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  if (!isUuid(userId)) return errors.notFound(c);
  const gate = await requireRole(user.id, id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  if (userId === user.id) {
    return jsonError(c, 400, "invalid_request", "请使用「账号」页修改自己的密码");
  }
  const mem = await query(
    "SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2",
    [id, userId],
  );
  if (!(mem.rowCount ?? 0)) return errors.notFound(c, "目标不是本空间成员");
  const body = (await c.req.json().catch(() => ({}))) as { new_password?: unknown };
  const next = typeof body.new_password === "string" ? body.new_password : "";
  if (next.length < 6) return jsonError(c, 400, "invalid_request", "新密码至少 6 位");
  const password_hash = await hashPassword(next);
  await query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [
    userId,
    password_hash,
  ]);
  return c.json({ ok: true });
});

spaceRoutes.get("/spaces/:id/activity", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const gate = await requireRole(user.id, id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;

  const yearsAll = (c.req.query("years") ?? "").trim().toLowerCase() === "all";
  const fromQ = (c.req.query("from") ?? "").trim();
  const toQ = (c.req.query("to") ?? "").trim();
  const wantRange = yearsAll || (isYmd(fromQ) && isYmd(toQ));

  /** Per-day authoring stats from source_updated_at only (never hub updated_at). */
  async function loadDayRows(since: Date) {
    // Heat intensity uses chars; skip per-day block counts (was LATERAL over
    // ~10k notes × 272k blocks ≈ 500–600ms). Tooltip still accepts blocks=0.
    return query<{ date: string; notes: number; chars: number; blocks: number }>(
      `SELECT to_char((source_updated_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS date,
              count(*)::int AS notes,
              coalesce(sum(char_length(coalesce(markdown, ''))), 0)::int AS chars,
              0::int AS blocks
       FROM notes
       WHERE space_id = $1
         AND deleted_at IS NULL
         AND source_updated_at IS NOT NULL
         AND source_updated_at >= $2
       GROUP BY 1`,
      [id, since],
    );
  }

  if (!wantRange) {
    const rawDays = Number(c.req.query("days") ?? 365);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(366, Math.floor(rawDays))) : 365;
    const since = new Date(Date.now() - days * 86400000);
    const rows = await loadDayRows(since);
    return c.json({
      days: buildActivitySeries({
        days,
        rows: rows.rows,
      }),
      /** Heat intensity uses chars (字数); blocks/notes are secondary. */
      intensity: "chars" as const,
    });
  }

  const today = shanghaiYmd(new Date());
  const maxYears = 10;
  let from = isYmd(fromQ) ? fromQ : "";
  let to = isYmd(toQ) ? toQ : today;

  if (yearsAll || !from) {
    const earliest = await query<{ d: string | null }>(
      `SELECT to_char(min(source_updated_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS d
       FROM notes
       WHERE space_id = $1 AND deleted_at IS NULL AND source_updated_at IS NOT NULL`,
      [id],
    );
    const minDate = earliest.rows[0]?.d;
    from = minDate && isYmd(minDate) ? minDate : today;
  }

  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }

  const toYear = Number(to.slice(0, 4));
  const fromYearRaw = Number(from.slice(0, 4));
  const minYear = toYear - (maxYears - 1);
  if (fromYearRaw < minYear) from = `${minYear}-01-01`;

  const since = new Date(`${from}T00:00:00+08:00`);
  since.setUTCDate(since.getUTCDate() - 1);

  const rows = await loadDayRows(since);
  const flat = buildActivityRange({
    from,
    to,
    rows: rows.rows,
  });
  const fromYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  const years = groupActivityByYear(flat, { fromYear, toYear: endYear });
  return c.json({ days: flat, years, from, to, intensity: "chars" as const });
});
