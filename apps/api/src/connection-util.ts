import { decryptSecret, encryptSecret, type ConnectionSecrets } from "@note-hub/core";
import { query } from "./db.ts";
import { env } from "./env.ts";

/** Drop cursor (multi-MB sync maps) + redact secrets_ref for all HTTP responses. */
export function publicConnection(row: Record<string, unknown>) {
  const { secrets_ref: _sr, cursor: _cursor, ...rest } = row;
  return { ...rest, secrets_ref: _sr ? "configured" : null };
}

export type ConnectionSecretFlags = {
  configured: boolean;
  access_key: boolean;
  secret_key: boolean;
  token: boolean;
  access_token: boolean;
  user_access_token: boolean;
  refresh_token: boolean;
  repo_password: boolean;
  app_id: boolean;
  app_secret: boolean;
};

const SECRET_FLAG_KEYS = [
  "access_key",
  "secret_key",
  "token",
  "access_token",
  "user_access_token",
  "refresh_token",
  "repo_password",
  "app_id",
  "app_secret",
] as const;

/** Booleans only — never ciphertext or secret values. Uses stored blob, not env defaults. */
export async function connectionSecretFlags(conn: {
  secrets_ref: string | null;
}): Promise<ConnectionSecretFlags> {
  const flags: ConnectionSecretFlags = {
    configured: Boolean(conn.secrets_ref),
    access_key: false,
    secret_key: false,
    token: false,
    access_token: false,
    user_access_token: false,
    refresh_token: false,
    repo_password: false,
    app_id: false,
    app_secret: false,
  };
  if (!conn.secrets_ref) return flags;
  const r = await query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE id = $1", [
    conn.secrets_ref,
  ]);
  const row = r.rows[0];
  if (!row) return flags;
  try {
    const json = JSON.parse(decryptSecret(row.ciphertext, env.hubSecret)) as Record<string, unknown>;
    for (const k of SECRET_FLAG_KEYS) {
      flags[k] = typeof json[k] === "string" && json[k].length > 0;
    }
  } catch {
    /* configured but unreadable — flags stay false; never surface ciphertext */
  }
  return flags;
}

function defaultMinioSecrets(conn: { source?: string; mode?: string | null; config?: { mode?: string } }): ConnectionSecrets | null {
  const mode = conn.mode || conn.config?.mode;
  if (conn.source === "obsidian" || (conn.source === "siyuan" && mode === "workspace")) {
    return { access_key: env.s3AccessKey, secret_key: env.s3SecretKey };
  }
  return null;
}

export async function decryptConnectionSecrets(conn: {
  secrets_ref: string | null;
  source?: string;
  mode?: string | null;
  config?: { mode?: string };
}): Promise<ConnectionSecrets | null> {
  if (!conn.secrets_ref) return defaultMinioSecrets(conn);
  const r = await query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE id = $1", [
    conn.secrets_ref,
  ]);
  const row = r.rows[0];
  if (!row) return defaultMinioSecrets(conn);
  const json = JSON.parse(decryptSecret(row.ciphertext, env.hubSecret)) as ConnectionSecrets;
  return json;
}
export async function persistEncryptedSecrets(secrets: ConnectionSecrets): Promise<string> {
  const blob = encryptSecret(JSON.stringify(secrets), env.hubSecret);
  const s = await query<{ id: string }>("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
  return String(s.rows[0].id);
}
