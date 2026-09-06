import "./load-env.ts";
import { refreshNoteLinks, type AdapterContext, type ConnectionRecord } from "@note-hub/core";
import { NotionAdapter } from "@note-hub/adapters";
import { decryptConnectionSecrets } from "./connection-util.ts";
import { pool, query, withTx } from "./db.ts";

type NoteRow = { id: string; space_id: string; connection_id: string; source_id: string; path: string; markdown: string | null };

type Counts = { notes: string; assets: string; blocks: string; chunks: string; links: string; acl_rows: string };

async function dependentCounts(connectionId: string): Promise<Counts> {
  const result = await query<Counts>(`SELECT
    count(DISTINCT n.id)::text AS notes,
    count(DISTINCT a.id)::text AS assets,
    count(DISTINCT b.id)::text AS blocks,
    count(DISTINCT ch.id)::text AS chunks,
    count(DISTINCT l.id)::text AS links,
    count(DISTINCT CASE WHEN n.acl_snapshot IS NOT NULL THEN n.id END)::text AS acl_rows
  FROM notes n
  LEFT JOIN assets a ON a.note_id=n.id
  LEFT JOIN blocks b ON b.note_id=n.id
  LEFT JOIN chunks ch ON ch.note_id=n.id
  LEFT JOIN links l ON l.from_note_id=n.id OR l.to_note_id=n.id
  WHERE n.connection_id=$1 AND n.deleted_at IS NULL`, [connectionId]);
  return result.rows[0];
}

async function main(): Promise<void> {
  const connections = await query<ConnectionRecord>("SELECT * FROM connections WHERE source='notion' ORDER BY created_at");
  let updated = 0;
  for (const conn of connections.rows) {
    const notes = await query<NoteRow>(
      "SELECT id,space_id,connection_id,source_id,path,markdown FROM notes WHERE connection_id=$1 AND deleted_at IS NULL ORDER BY created_at",
      [conn.id],
    );
    if (!notes.rows.length) continue;
    const secrets = await decryptConnectionSecrets(conn);
    const adapter = new NotionAdapter();
    const ctx: AdapterContext = { connection: conn, secrets, cursor: conn.cursor };
    const before = await dependentCounts(conn.id);
    const paths: { note: NoteRow; path: string }[] = [];
    for (const note of notes.rows) {
      const path = await adapter.resolvePath(ctx, note.source_id);
      if (!path) throw new Error(`Notion path unavailable for ${note.source_id}`);
      paths.push({ note, path });
    }
    await withTx(async (client) => {
      for (const { note, path } of paths) {
        if (path === note.path) continue;
        await client.query("UPDATE notes SET path=$2,updated_at=now() WHERE id=$1", [note.id, path]);
        updated++;
      }
    });
    // note_links may resolve wiki-style targets by path. Rebuild affected source rows when that migration exists.
    const hasNoteLinks = await query<{ exists: boolean }>("SELECT to_regclass('public.note_links') IS NOT NULL AS exists");
    if (hasNoteLinks.rows[0]?.exists) {
      for (const { note, path } of paths) {
        await refreshNoteLinks(query, {
          id: note.id,
          spaceId: note.space_id,
          connectionId: note.connection_id,
          source: "notion",
          sourceId: note.source_id,
          path,
          markdown: note.markdown ?? "",
        });
      }
    }
    const after = await dependentCounts(conn.id);
    console.log(JSON.stringify({ connection_id: conn.id, notes: notes.rows.length, updated: paths.filter(({ note, path }) => note.path !== path).length, before, after }));
  }
  console.log(JSON.stringify({ updated }));
}

main()
  .then(async () => { await pool.end(); })
  .catch(async (error) => { console.error(error instanceof Error ? error.message : String(error)); await pool.end(); process.exitCode = 1; });
