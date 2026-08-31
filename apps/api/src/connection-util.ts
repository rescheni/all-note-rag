import { decryptSecret, type ConnectionSecrets } from "@note-hub/core";
import { query } from "./db.ts";
import { env } from "./env.ts";

export function publicConnection(row: Record<string, unknown>) {
  const { secrets_ref: _sr, ...rest } = row;
  return { ...rest, secrets_ref: _sr ? "configured" : null };
}

export async function decryptConnectionSecrets(conn: {
  secrets_ref: string | null;
}): Promise<ConnectionSecrets | null> {
  if (!conn.secrets_ref) {
    return { access_key: env.s3AccessKey, secret_key: env.s3SecretKey };
  }
  const r = await query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE id = $1", [
    conn.secrets_ref,
  ]);
  const row = r.rows[0];
  if (!row) return { access_key: env.s3AccessKey, secret_key: env.s3SecretKey };
  const json = JSON.parse(decryptSecret(row.ciphertext, env.hubSecret)) as ConnectionSecrets;
  return json;
}
