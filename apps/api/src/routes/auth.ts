import { Hono } from "hono";
import { ensureSkillOnSpace } from "@note-hub/skills-runtime";
import { query, withTx } from "../db.ts";
import { errors, jsonError } from "../errors.ts";
import {
  clearSessionCookie,
  generateApiToken,
  hashPassword,
  requireUser,
  setSessionCookie,
  signToken,
  verifyPassword,
  type AuthUser,
} from "../auth.ts";

type Vars = { user: AuthUser };

export const authRoutes = new Hono<{ Variables: Vars }>();

export type CreatedUser = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
};

/**
 * Create a user row. When withPersonalSpace is false (sub-accounts), skip the
 * auto personal space so the account mainly joins the parent space.
 */
export async function createUser(opts: {
  email: string;
  password: string;
  display_name?: string | null;
  withPersonalSpace?: boolean;
}): Promise<{ user: CreatedUser; space: Record<string, unknown> | null }> {
  const email = opts.email.trim().toLowerCase();
  const password_hash = await hashPassword(opts.password);
  const display_name = (opts.display_name?.trim() || email.split("@")[0]) ?? email;
  const withPersonalSpace = opts.withPersonalSpace !== false;

  return withTx(async (tx) => {
    const u = await tx.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1,$2,$3) RETURNING id, email, display_name, created_at`,
      [email, password_hash, display_name],
    );
    const user = u.rows[0] as CreatedUser;
    if (!withPersonalSpace) return { user, space: null };

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
}

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
  const out = await createUser({
    email,
    password,
    display_name: body.display_name,
    withPersonalSpace: true,
  });
  if (out.space?.id) {
    try {
      await ensureSkillOnSpace(query, String(out.space.id), "growth-weekly");
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: "auto-install growth-weekly failed", error: String(e) }));
    }
  }
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
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post("/auth/password", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as {
    current_password?: string;
    new_password?: string;
  };
  const current = body.current_password ?? "";
  const next = body.new_password ?? "";
  if (next.length < 6) {
    return jsonError(c, 400, "invalid_request", "新密码至少 6 位");
  }
  const r = await query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [user.id],
  );
  const row = r.rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return jsonError(c, 401, "unauthenticated", "当前密码错误");
  }
  const password_hash = await hashPassword(next);
  await query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [
    user.id,
    password_hash,
  ]);
  return c.json({ ok: true });
});

authRoutes.get("/auth/tokens", requireUser, async (c) => {
  const user = c.get("user");
  const r = await query<{
    id: string;
    name: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    `SELECT id, name, token_prefix, created_at, last_used_at
     FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [user.id],
  );
  return c.json({ tokens: r.rows });
});

authRoutes.post("/auth/tokens", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({})) as { name?: string };
  const name = (body.name ?? "").trim();
  if (!name) return jsonError(c, 400, "invalid_request", "需要令牌名称");
  const { token, prefix, hash } = generateApiToken();
  const r = await query<{
    id: string;
    name: string;
    token_prefix: string;
    created_at: string;
  }>(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, token_prefix, created_at`,
    [user.id, name, prefix, hash],
  );
  const row = r.rows[0];
  return c.json(
    {
      token,
      id: row.id,
      name: row.name,
      token_prefix: row.token_prefix,
      created_at: row.created_at,
    },
    201,
  );
});

authRoutes.delete("/auth/tokens/:id", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const r = await query(
    `UPDATE api_tokens SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [id, user.id],
  );
  if (!(r.rowCount ?? 0)) return errors.notFound(c);
  return c.json({ ok: true });
});
