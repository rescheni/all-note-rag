import { Hono } from "hono";
import {
  encryptSecret,
  isSiyuanRepoErrorCode,
  mergeConnectionSecrets,
  pickSecrets,
  secretsHavePayload,
  validateConnectionInput,
  type ConnectionConfig,
  type ConnectionSecrets,
} from "@note-hub/core";
import { createAdapter } from "@note-hub/adapters";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { enqueueSync, enqueueSyncFiles } from "../queue.ts";
import { connectionSecretFlags, decryptConnectionSecrets, persistEncryptedSecrets, publicConnection } from "../connection-util.ts";
import { runContactsSync } from "../contacts-sync.ts";

type Vars = { user: AuthUser };
export const connectionRoutes = new Hono<{ Variables: Vars }>();
connectionRoutes.use("*", requireUser);

function hasSecretPayload(s: ConnectionSecrets): boolean {
  return secretsHavePayload(s);
}

const LATEST_RUN_SELECT = `id, started_at, finished_at, upserts, files_total, files_done, chunks_total, chunks_done, failed, skipped`;

type LatestRunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  upserts: number;
  files_total: number;
  files_done: number;
  chunks_total: number;
  chunks_done: number;
  failed: number;
  skipped: number;
};

function publicLatestRun(row: LatestRunRow | null | undefined): LatestRunRow | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    upserts: Number(row.upserts ?? 0),
    files_total: Number(row.files_total ?? 0),
    files_done: Number(row.files_done ?? 0),
    chunks_total: Number(row.chunks_total ?? 0),
    chunks_done: Number(row.chunks_done ?? 0),
    failed: Number(row.failed ?? 0),
    skipped: Number(row.skipped ?? 0),
  };
}

connectionRoutes.get("/spaces/:id/connections", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const r = await query<{ connection: Record<string, unknown>; latest_run: LatestRunRow | null }>(
    `SELECT to_jsonb(c) AS connection, to_jsonb(lr) AS latest_run
     FROM connections c
     LEFT JOIN LATERAL (
       SELECT ${LATEST_RUN_SELECT}
       FROM sync_run
       WHERE connection_id = c.id
       ORDER BY (finished_at IS NULL) DESC, started_at DESC
       LIMIT 1
     ) lr ON true
     WHERE c.space_id = $1
     ORDER BY c.created_at`,
    [spaceId],
  );
  return c.json({
    connections: r.rows.map((row) => ({
      ...publicConnection(row.connection),
      latest_run: publicLatestRun(row.latest_run),
    })),
  });
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
  if (useDefaultMinio && !secrets.access_key && !secrets.secret_key) {
    secrets = { ...secrets, access_key: env.s3AccessKey, secret_key: env.s3SecretKey };
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


connectionRoutes.get("/connections/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const gate = await requireRole(user.id, conn.space_id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const secrets = await connectionSecretFlags(conn);
  const latest = await query<LatestRunRow>(
    `SELECT ${LATEST_RUN_SELECT} FROM sync_run WHERE connection_id = $1 ORDER BY (finished_at IS NULL) DESC, started_at DESC LIMIT 1`,
    [id],
  );
  return c.json({
    connection: { ...publicConnection(conn), latest_run: publicLatestRun(latest.rows[0]) },
    secrets,
  });
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
    mode?: string | null;
    secrets?: ConnectionSecrets;
  };
  const config = { ...(conn.config as object), ...(body.config ?? {}) };
  let secretsRef = conn.secrets_ref;
  if (body.secrets) {
    const incoming = pickSecrets(body.secrets as Record<string, unknown>);
    if (secretsHavePayload(incoming)) {
      const existing = await decryptConnectionSecrets(conn);
      const merged = mergeConnectionSecrets(existing, incoming);
      const blob = encryptSecret(JSON.stringify(merged), env.hubSecret);
      const s = await query("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
      secretsRef = s.rows[0].id;
    }
  }
  const status = body.status ?? conn.status;
  const mode = body.mode !== undefined ? body.mode : conn.mode;
  const r = await query(
    `UPDATE connections SET name = COALESCE($2, name), config = $3::jsonb, secrets_ref = $4,
      status = $5, mode = $6, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, body.name ?? null, JSON.stringify(config), secretsRef, status, mode],
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
    persistSecrets: async (next) => {
      const ref = await persistEncryptedSecrets(next);
      await query("UPDATE connections SET secrets_ref = $2, updated_at = now() WHERE id = $1", [id, ref]);
    },
  });
  if (result.status) {
    await query(
      "UPDATE connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
      [id, result.status, result.ok ? null : result.message ?? null],
    );
  }
  if (result.status === "encrypted_unreadable") return errors.encrypted(c);
  if (isSiyuanRepoErrorCode(result.code)) {
    return jsonError(c, 400, result.code, result.message ?? "思源仓库错误");
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
  let body: { keys?: unknown } = {};
  try {
    body = (await c.req.json()) as { keys?: unknown };
  } catch {
    body = {};
  }
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  if (keys.length) {
    const q = await enqueueSyncFiles(id, keys, { debounceMs: 0 });
    return c.json({ ok: true, job_id: q.jobId, keys: q.keys ?? keys });
  }
  const q = await enqueueSync(id);
  if (!q.queued && q.reason === "sync_in_progress") return errors.syncInProgress(c);
  if (conn.source === "feishu") {
    void runContactsSync(id).catch((err) => {
      console.error(JSON.stringify({
        level: "error",
        message: "feishu contacts sync failed",
        connection_id: id,
        error: err instanceof Error ? err.message : String(err),
      }));
    });
  }
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
    `SELECT * FROM sync_run WHERE connection_id = $1 ORDER BY (finished_at IS NULL) DESC, started_at DESC LIMIT 5`,
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

connectionRoutes.post("/connections/:id/contacts/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const gate = await requireRole(user.id, conn.space_id, "editor");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  if (conn.source !== "feishu") {
    return jsonError(c, 400, "invalid_request", "仅飞书连接支持同步通讯录");
  }
  try {
    const contacts_sync = await runContactsSync(id);
    return c.json({ ok: true, contacts_sync });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonError(c, 400, "contacts_sync_failed", message);
  }
});

connectionRoutes.get("/connections/:id/contacts", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await query("SELECT * FROM connections WHERE id = $1", [id]);
  const conn = row.rows[0];
  if (!conn) return errors.notFound(c);
  const gate = await requireRole(user.id, conn.space_id, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const cfg = (conn.config ?? {}) as { contacts_sync?: unknown };
  return c.json({ contacts_sync: cfg.contacts_sync ?? null });
});
