import { Hono } from "hono";
import {
  encryptSecret,
  SIYUAN_OFFICIAL_S3_CODE,
  validateConnectionInput,
  type ConnectionConfig,
  type ConnectionSecrets,
} from "@note-hub/core";
import { createAdapter } from "@note-hub/adapters";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { enqueueSync } from "../queue.ts";
import { decryptConnectionSecrets, publicConnection } from "../connection-util.ts";

type Vars = { user: AuthUser };
export const connectionRoutes = new Hono<{ Variables: Vars }>();
connectionRoutes.use("*", requireUser);

function hasSecretPayload(s: ConnectionSecrets): boolean {
  return Boolean(s.access_key || s.secret_key || s.token || s.app_id || s.app_secret);
}

connectionRoutes.get("/spaces/:id/connections", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const r = await query("SELECT * FROM connections WHERE space_id = $1 ORDER BY created_at", [spaceId]);
  return c.json({ connections: r.rows.map(publicConnection) });
});

connectionRoutes.post("/spaces/:id/connections", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const parsed = validateConnectionInput(body);
  if (!parsed.ok) {
    return jsonError(c, 400, parsed.code, parsed.message);
  }
  const value = parsed.value;
  if (
    (value.source === "obsidian" || (value.source === "siyuan" && value.mode === "workspace")) &&
    !value.config.endpoint
  ) {
    value.config.endpoint = env.s3Endpoint;
  }
  let secrets = value.secrets;
  const useDefaultMinio =
    value.source === "obsidian" || (value.source === "siyuan" && value.mode === "workspace");
  if (!hasSecretPayload(secrets) && useDefaultMinio) {
    secrets = { access_key: env.s3AccessKey, secret_key: env.s3SecretKey };
  }
  // never default MinIO keys for notion / feishu / siyuan-api
  let secretsRef: string | null = null;
  if (hasSecretPayload(secrets)) {
    const blob = encryptSecret(JSON.stringify(secrets), env.hubSecret);
    const s = await query("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    secretsRef = s.rows[0].id;
  }
  const r = await query(
    `INSERT INTO connections (space_id, source, name, config, secrets_ref, status, mode)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     RETURNING *`,
    [spaceId, value.source, value.name, JSON.stringify(value.config), secretsRef, value.status, value.mode],
  );
  const row = r.rows[0];
  return c.json({ connection: publicConnection(row) }, 201);
});

connectionRoutes.patch("/connections/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const gate = await requireRole(user.id, conn.space_id, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({})) as {
    name?: string;
    config?: Partial<ConnectionConfig>;
    status?: string;
    secrets?: ConnectionSecrets;
  };
  const config = { ...(conn.config as object), ...(body.config ?? {}) };
  let secretsRef = conn.secrets_ref;
  if (body.secrets && hasSecretPayload(body.secrets)) {
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
  const gate = await requireRole(user.id, conn.space_id, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const secrets = await decryptConnectionSecrets(conn);
  const adapter = createAdapter(conn.source);
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
  if (result.code === SIYUAN_OFFICIAL_S3_CODE) {
    return jsonError(c, 400, result.code, result.message ?? "官方 S3 不受支持");
  }
  return c.json({ probe: result });
});

connectionRoutes.post("/connections/:id/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const gate = await requireRole(user.id, conn.space_id, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
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
  const gate = await requireRole(user.id, conn.space_id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
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
