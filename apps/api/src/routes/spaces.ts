import { Hono } from "hono";
import { query } from "../db.ts";
import { errors } from "../errors.ts";
import { loadMembership, requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const spaceRoutes = new Hono<{ Variables: Vars }>();

spaceRoutes.use("*", requireUser);

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
  return errors.forbidden(c, "P0 仅支持注册时自动创建的个人空间");
});

spaceRoutes.get("/spaces/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const mem = await loadMembership(user.id, id);
  if (!mem) return errors.notFound(c);
  const r = await query("SELECT id, kind, name, owner_user_id, created_at, updated_at FROM spaces WHERE id = $1", [id]);
  if (!r.rows[0]) return errors.notFound(c);
  return c.json({ space: r.rows[0], role: mem.role });
});

spaceRoutes.get("/spaces/:id/members", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const mem = await loadMembership(user.id, id);
  if (!mem) return errors.notFound(c);
  const r = await query(
    `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
     FROM space_members m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = $1`,
    [id],
  );
  return c.json({ members: r.rows });
});
