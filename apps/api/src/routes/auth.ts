import { Hono } from "hono";
import { query, withTx } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import { hashPassword, requireUser, setSessionCookie, signToken, verifyPassword, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };

export const authRoutes = new Hono<{ Variables: Vars }>();

authRoutes.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    email?: string;
    password?: string;
    display_name?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !email.includes("@") || password.length < 6) {
    return jsonError(c, 400, "invalid_request", "邮箱或密码不合法（密码至少 6 位）");
  }
  const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if ((exists.rowCount ?? 0) > 0) return jsonError(c, 409, "conflict", "该邮箱已注册");
  const password_hash = await hashPassword(password);
  const display_name = body.display_name?.trim() || email.split("@")[0];
  const out = await withTx(async (tx) => {
    const u = await tx.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1,$2,$3) RETURNING id, email, display_name, created_at`,
      [email, password_hash, display_name],
    );
    const user = u.rows[0];
    const s = await tx.query(
      `INSERT INTO spaces (kind, name, owner_user_id)
       VALUES ('personal', $1, $2) RETURNING id, kind, name, owner_user_id, created_at`,
      [`${display_name} 的个人空间`, user.id],
    );
    const space = s.rows[0];
    await tx.query(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1,$2,'owner')`,
      [space.id, user.id],
    );
    return { user, space };
  });
  const token = signToken(out.user.id);
  setSessionCookie(c, token);
  return c.json({ user: out.user, space: out.space, token }, 201);
});

authRoutes.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const r = await query<{ id: string; email: string; display_name: string | null; password_hash: string }>(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
    [email],
  );
  const row = r.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return jsonError(c, 401, "unauthenticated", "邮箱或密码错误");
  }
  const token = signToken(row.id);
  setSessionCookie(c, token);
  return c.json({
    user: { id: row.id, email: row.email, display_name: row.display_name },
    token,
  });
});

authRoutes.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  return c.json({ user });
});

authRoutes.post("/auth/logout", async (c) => {
  c.header("Set-Cookie", "hub_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return c.json({ ok: true });
});
