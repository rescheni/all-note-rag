import { extractNoteLinkCandidates, normalizeNativeId, type NoteLinkCandidate } from "./note-links.ts";
import type { SourceKind } from "./types.ts";

export type NoteLinkRow = NoteLinkCandidate & { targetNoteId: string | null; targetTitle?: string; targetPath?: string };
export type LinkStoreNote = { id: string; spaceId: string; connectionId: string; source: SourceKind; sourceId: string; path: string; markdown: string };
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

function cleanPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/").replace(/\.md$/i, "").toLowerCase();
}

async function resolveCandidate(query: Query, note: LinkStoreNote, link: NoteLinkCandidate) {
  if (link.nativeId) {
    const native = normalizeNativeId(link.nativeId);
    const found = await query<{ id: string; title: string; path: string }>(
      `SELECT DISTINCT n.id, n.title, n.path FROM notes n
       LEFT JOIN blocks b ON b.note_id = n.id
       WHERE n.connection_id = $1 AND n.deleted_at IS NULL
         AND (lower(replace(n.source_id, '-', '')) = $2 OR lower(replace(b.source_block_id, '-', '')) = $2
              OR lower(replace(COALESCE(n.frontmatter->>'obj_token',''), '-', '')) = $2)
       ORDER BY n.id LIMIT 1`, [note.connectionId, native],
    );
    return found.rows[0] ?? null;
  }
  const raw = cleanPath(link.path || link.rawTarget);
  const dir = cleanPath(note.path).split("/").slice(0, -1).join("/");
  const sameDir = dir && !raw.includes("/") ? `${dir}/${raw}` : raw;
  const title = (link.title || raw.split("/").pop() || raw).replace(/\.md$/i, "");
  const found = await query<{ id: string; title: string; path: string }>(
    `SELECT id, title, path FROM notes WHERE connection_id = $1 AND deleted_at IS NULL
       AND (lower(regexp_replace(path, '\\.md$', '', 'i')) = ANY($2::text[]) OR lower(title) = lower($3))
     ORDER BY CASE WHEN lower(regexp_replace(path, '\\.md$', '', 'i')) = $4 THEN 0
                   WHEN lower(regexp_replace(path, '\\.md$', '', 'i')) = $5 THEN 1 ELSE 2 END, path LIMIT 1`,
    [note.connectionId, [...new Set([raw, sameDir])], title, sameDir, raw],
  );
  return found.rows[0] ?? null;
}

/** Replace all outgoing edges for a note. Stale links disappear when content changes. */
export async function refreshNoteLinks(query: Query, note: LinkStoreNote): Promise<NoteLinkRow[]> {
  const candidates = extractNoteLinkCandidates(note.markdown, note.source);
  const rows: NoteLinkRow[] = [];
  await query("DELETE FROM note_links WHERE source_note_id = $1", [note.id]);
  for (const link of candidates) {
    const target = await resolveCandidate(query, note, link);
    await query(
      `INSERT INTO note_links (space_id, connection_id, source_note_id, target_note_id, raw_target, raw_link, label, link_kind, source_offset, heading, native_target_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [note.spaceId, note.connectionId, note.id, target?.id ?? null, link.rawTarget, link.raw, link.label, link.kind, link.index, link.heading ?? null, link.nativeId ?? null],
    );
    rows.push({ ...link, targetNoteId: target?.id ?? null, targetTitle: target?.title, targetPath: target?.path });
  }
  return rows;
}
