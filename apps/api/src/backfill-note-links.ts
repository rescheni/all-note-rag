import "./load-env.ts";
import { extractNoteLinkCandidates, refreshNoteLinks, type SourceKind } from "@note-hub/core";
import { query } from "./db.ts";

type Row = { id: string; space_id: string; connection_id: string; source_id: string; path: string; markdown: string | null; source: SourceKind };
async function main() {
  const notes = await query<Row>(`SELECT n.id,n.space_id,n.connection_id,n.source_id,n.path,n.markdown,c.source
    FROM notes n JOIN connections c ON c.id=n.connection_id WHERE n.deleted_at IS NULL ORDER BY n.created_at`);
  let scanned = 0, edges = 0, resolved = 0;
  for (const note of notes.rows) {
    const markdown = note.markdown ?? "";
    if (!extractNoteLinkCandidates(markdown, note.source).length) { scanned++; continue; }
    const links = await refreshNoteLinks(query, { id: note.id, spaceId: note.space_id, connectionId: note.connection_id,
      source: note.source, sourceId: note.source_id, path: note.path, markdown });
    scanned++; edges += links.length; resolved += links.filter((link) => link.targetNoteId).length;
    if (scanned % 500 === 0) console.log(JSON.stringify({ scanned, total: notes.rows.length, edges, resolved }));
  }
  // Remove stale edges for notes that now contain no candidates as well.
  await query(`DELETE FROM note_links l USING notes n WHERE l.source_note_id=n.id AND n.deleted_at IS NOT NULL`);
  console.log(JSON.stringify({ scanned, edges, resolved, dangling: edges - resolved }));
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
