import { Hono } from "hono";
import { encryptSecret, type ConnectionConfig } from "@note-hub/core";
import { ObsidianAdapter } from "@note-hub/adapters";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { loadMembership, requireUser, type AuthUser } from "../auth.ts";
import { enqueueSync } from "../queue.ts";
import { decryptConnectionSecrets, publicConnection } from "../connection-util.ts";

type Vars = { user: AuthUser };
export const connectionRoutes = new Hono<{ Variables: Vars }>();
connectionRoutes.use("*", requireUser);

function canManage(role: string): boolean {
  return role === "owner" || role === "editor";
}

connectionRoutes.get("/spaces/:id/connections", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  if (!(await loadMembership(user.id, spaceId))) return errors.notFound(c);
  const r = await query("SELECT * FROM connections WHERE space_id = $1 ORDER BY created_at", [spaceId]);
  return c.json({ connections: r.rows.map(publicConnection) });
});

connectionRoutes.post("/spaces/:id/connections", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const mem = await loadMembership(user.id, spaceId);
  if (!mem) return errors.notFound(c);
  if (!canManage(mem.role)) return errors.forbidden(c);
  const body = await c.req.json().catch(() => ({})) as {
    source?: string;
    name?: string;
    config?: ConnectionConfig;
    secrets?: { access_key?: string; secret_key?: string };
  };
  if (body.source && body.source !== "obsidian") {
    return jsonError(c, 400, "invalid_request", "P0 仅支持 obsidian 连接");
  }
  const config: ConnectionConfig = {
    bucket: body.config?.bucket ?? "",
    region: body.config?.region ?? "us-east-1",
    remote_prefix: body.config?.remote_prefix ?? "vault1",
    endpoint: body.config?.endpoint ?? env.s3Endpoint,
    ignore: body.config?.ignore ?? [".obsidian/", ".trash/"],
    e2ee: Boolean(body.config?.e2ee),
    force_path_style: true,
  };
  if (!config.bucket) return jsonError(c, 400, "invalid_request", "缺少 bucket");
  const name = (body.name ?? "Obsidian").trim();
  let secretsRef: string | null = null;
  if (body.secrets?.access_key && body.secrets?.secret_key) {
    const blob = encryptSecret(JSON.stringify(body.secrets), env.hubSecret);
    const s = await query("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    secretsRef = s.rows[0].id;
  }
  const status = config.e2ee ? "encrypted_unreadable" : "active";
  const r = await query(
    `INSERT INTO connections (space_id, source, name, config, secrets_ref, status)
     VALUES ($1,'obsidian',$2,$3::jsonb,$4,$5)
     RETURNING *`,
    [spaceId, name, JSON.stringify(config), secretsRef, status],
  );
  return c.json({ connection: publicConnection(r.rows[0]) }, 201);
});

connectionRoutes.patch("/connections/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const mem = await loadMembership(user.id, conn.space_id);
  if (!mem) return errors.notFound(c);
  if (!canManage(mem.role)) return errors.forbidden(c);
  const body = await c.req.json().catch(() => ({})) as {
    name?: string;
    config?: Partial<ConnectionConfig>;
    status?: string;
    secrets?: { access_key?: string; secret_key?: string };
  };
  const config = { ...(conn.config as object), ...(body.config ?? {}) };
  let secretsRef = conn.secrets_ref;
  if (body.secrets?.access_key && body.secrets?.secret_key) {
    const blob = encryptSecret(JSON.stringify(body.secrets), env.hubSecret);
    const s = await query("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    secretsRef = s.rows[0].id;
  }
  const status = body.status ?? conn.status;
  const r = await query(
    `UPDATE connections SET name = COALESCE($2, name), config = $3::jsonb, secrets_ref = $4,
      status = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, body.name ?? null, JSON.stringify(config), secretsRef, status],
  );
  return c.json({ connection: publicConnection(r.rows[0]) });
});

connectionRoutes.post("/connections/:id/probe", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const mem = await loadMembership(user.id, conn.space_id);
  if (!mem) return errors.notFound(c);
  if (!canManage(mem.role)) return errors.forbidden(c);
  const secrets = await decryptConnectionSecrets(conn);
  const adapter = new ObsidianAdapter();
  const result = await adapter.probe({
    connection: { ...conn, config: conn.config },
    secrets,
    cursor: conn.cursor,
  });
  if (result.status) {
    await query(
      "UPDATE connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
      [id, result.status, result.ok ? null : result.message ?? null],
    );
  }
  if (result.status === "encrypted_unreadable") return errors.encrypted(c);
  return c.json({ probe: result });
});

connectionRoutes.post("/connections/:id/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const mem = await loadMembership(user.id, conn.space_id);
  if (!mem) return errors.notFound(c);
  if (!canManage(mem.role)) return errors.forbidden(c);
  if (conn.status === "encrypted_unreadable" || conn.config?.e2ee) return errors.encrypted(c);
  const q = await enqueueSync(id);
  if (!q.queued && q.reason === "sync_in_progress") return errors.syncInProgress(c);
  return c.json({ ok: true, job_id: `sync:${id}` });
});

connectionRoutes.get("/connections/:id/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  if (!(await loadMembership(user.id, conn.space_id))) return errors.notFound(c);
  const runs = await query(
    `SELECT * FROM sync_run WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 5`,
    [id],
  );
  const logs = await query(
    `SELECT * FROM sync_note_log WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [id],
  );
  return c.json({
    connection: publicConnection(conn),
    runs: runs.rows,
    logs: logs.rows,
  });
});
