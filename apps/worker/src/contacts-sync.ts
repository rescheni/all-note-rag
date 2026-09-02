import {
  contactsSyncSnapshot,
  decryptSecret,
  type ConnectionRecord,
  type ConnectionSecrets,
  type ContactsSyncSnapshot,
} from "@note-hub/core";
import { runFeishuContactsSync } from "@note-hub/adapters";
import { query } from "./db.ts";
import { env } from "./env.ts";

type ConnRow = ConnectionRecord & { space_kind: string };

async function loadSecrets(conn: ConnectionRecord): Promise<ConnectionSecrets | null> {
  if (!conn.secrets_ref) return null;
  const r = await query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE id = $1", [conn.secrets_ref]);
  if (!r.rows[0]) return null;
  return JSON.parse(decryptSecret(r.rows[0].ciphertext, env.hubSecret)) as ConnectionSecrets;
}

async function persistSnapshot(connectionId: string, snap: ContactsSyncSnapshot): Promise<void> {
  await query(
    `UPDATE connections
     SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('contacts_sync', $2::jsonb),
         updated_at = now()
     WHERE id = $1`,
    [connectionId, JSON.stringify(snap)],
  );
}

export async function runContactsSync(
  connectionId: string,
  fetchFn?: typeof fetch,
): Promise<ContactsSyncSnapshot | null> {
  const r = await query<ConnRow>(
    `SELECT c.*, s.kind AS space_kind
     FROM connections c
     JOIN spaces s ON s.id = c.space_id
     WHERE c.id = $1`,
    [connectionId],
  );
  const conn = r.rows[0];
  if (!conn || conn.source !== "feishu") return null;
  const secrets = await loadSecrets(conn);
  const members = await query<{ user_id: string }>(
    "SELECT user_id FROM space_members WHERE space_id = $1",
    [conn.space_id],
  );
  try {
    const snap = await runFeishuContactsSync({
      ctx: { connection: conn, secrets, cursor: conn.cursor },
      fetchFn: fetchFn ?? globalThis.fetch,
      spaceKind: conn.space_kind,
      existingMemberIds: new Set(members.rows.map((m) => m.user_id)),
      findUsersByEmails: async (emails) => {
        if (!emails.length) return [];
        const u = await query<{ id: string; email: string }>(
          "SELECT id, email FROM users WHERE lower(email) = ANY($1::text[])",
          [emails.map((e) => e.toLowerCase())],
        );
        return u.rows;
      },
      insertViewerIfAbsent: async (userId) => {
        const ins = await query(
          `INSERT INTO space_members (space_id, user_id, role)
           VALUES ($1, $2, 'viewer')
           ON CONFLICT (space_id, user_id) DO NOTHING`,
          [conn.space_id, userId],
        );
        return (ins.rowCount ?? 0) > 0;
      },
    });
    await persistSnapshot(connectionId, snap);
    return snap;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const fail = contactsSyncSnapshot(
      { toAdd: [], pulled: 0, matched: 0, skipped: 0, already_member: 0 },
      0,
      { error: message },
    );
    await persistSnapshot(connectionId, fail);
    console.error(
      JSON.stringify({
        level: "error",
        message: "feishu contacts sync failed",
        connection_id: connectionId,
        error: message,
      }),
    );
    return fail;
  }
}
