import { toFtsTokens, toTsQueryTokens } from "@note-hub/core";

export const UNKNOWN_ANSWER = "不知道";

export type RetrieveChunk = {
  note_id: string;
  title: string;
  space_id: string;
  text: string;
  heading_path?: string | null;
  block_id?: string | null;
  source_block_id?: string | null;
};

export type RetrieveHit = {
  note_id: string;
  title: string;
  space_id: string;
  block_id: string;
  source_block_id: string;
  text: string;
  quote: string;
  rank: number;
  preview_url: string;
};

export type LoadChunks = (
  spaceId: string,
  query: string,
  opts?: { noteIds?: string[]; limit?: number },
) => Promise<RetrieveChunk[]>;

export type HybridRetrieveOpts = {
  noteIds?: string[];
  limit?: number;
  /** In-memory corpus for tests; skips loadChunks. */
  chunks?: RetrieveChunk[];
  loadChunks?: LoadChunks;
};

export type HybridRetrieveResult = {
  unknown: boolean;
  hits: RetrieveHit[];
};

export function previewUrl(noteId: string, sourceBlockId?: string | null): string {
  const id = sourceBlockId?.trim();
  return id ? `/notes/${noteId}#b-${id}` : `/notes/${noteId}`;
}

export function clipQuote(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

export function scoreChunk(query: string, chunk: RetrieveChunk): number {
  const q = query.trim();
  if (!q) return 0;
  const qLower = q.toLowerCase();
  const title = chunk.title.toLowerCase();
  const body = `${chunk.heading_path ?? ""} ${chunk.text}`.toLowerCase();
  let score = 0;
  if (title.includes(qLower)) score += 2;
  if (body.includes(qLower)) score += 1;
  const qTokens = toFtsTokens(q).split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return score;
  const titleTok = new Set(toFtsTokens(chunk.title).split(/\s+/).filter(Boolean));
  const bodyTok = new Set(toFtsTokens(`${chunk.heading_path ?? ""} ${chunk.text}`).split(/\s+/).filter(Boolean));
  for (const tok of qTokens) {
    const t = tok.toLowerCase();
    if (titleTok.has(t) || title.includes(t)) score += 0.5;
    if (bodyTok.has(t) || body.includes(t)) score += 0.25;
  }
  return score;
}

export async function hybridRetrieve(
  spaceId: string,
  queryText: string,
  opts: HybridRetrieveOpts = {},
): Promise<HybridRetrieveResult> {
  const q = queryText.trim();
  const limit = opts.limit ?? 8;
  if (!q) return { unknown: true, hits: [] };

  let chunks: RetrieveChunk[];
  if (opts.chunks) {
    chunks = opts.chunks;
  } else if (opts.loadChunks) {
    chunks = await opts.loadChunks(spaceId, q, {
      noteIds: opts.noteIds,
      limit: Math.max(limit * 5, 40),
    });
  } else {
    chunks = [];
  }

  const noteFilter = opts.noteIds && opts.noteIds.length > 0 ? new Set(opts.noteIds) : null;
  const scored: RetrieveHit[] = [];
  for (const ch of chunks) {
    if (ch.space_id !== spaceId) continue;
    if (noteFilter && !noteFilter.has(ch.note_id)) continue;
    const rank = scoreChunk(q, ch);
    if (rank <= 0) continue;
    const sourceBlockId = (ch.source_block_id ?? "").trim();
    const blockId = sourceBlockId || (ch.block_id ?? "");
    scored.push({
      note_id: ch.note_id,
      title: ch.title,
      space_id: ch.space_id,
      block_id: blockId,
      source_block_id: sourceBlockId,
      text: ch.text,
      quote: clipQuote(ch.text),
      rank,
      preview_url: previewUrl(ch.note_id, sourceBlockId),
    });
  }
  scored.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title, "zh"));
  const hits = scored.slice(0, limit);
  if (hits.length === 0) return { unknown: true, hits: [] };
  return { unknown: false, hits };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SqlQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;

type SqlRow = {
  note_id: string;
  title: string;
  space_id: string;
  text: string;
  heading_path: string | null;
  block_uuid: string | null;
  source_block_id: string | null;
};

export function loadChunksViaSql(run: SqlQuery): LoadChunks {
  return async (spaceId, queryText, opts) => {
    const like = "%" + queryText.trim() + "%";
    const tokens = toTsQueryTokens(queryText);
    const rawIds = opts?.noteIds ?? [];
    const noteIds = rawIds.filter((id) => UUID_RE.test(id));
    const hasNotes = noteIds.length > 0;
    const limit = opts?.limit ?? 40;
    const r = await run(
      `SELECT n.id AS note_id, n.title, n.space_id, ch.text, ch.heading_path,
              b.id AS block_uuid, b.source_block_id
       FROM chunks ch
       INNER JOIN notes n ON n.id = ch.note_id AND n.deleted_at IS NULL
       LEFT JOIN blocks b ON b.id = ch.block_id
       WHERE n.space_id = $1 AND ch.space_id = $1
         AND ($4::uuid[] IS NULL OR n.id = ANY($4::uuid[]))
         AND (
           n.title ILIKE $2
           OR ch.text ILIKE $2
           OR COALESCE(ch.heading_path, '') ILIKE $2
           OR ($3 <> '' AND ch.fts @@ to_tsquery('simple', $3))
         )
       ORDER BY (
         CASE WHEN n.title ILIKE $2 THEN 1.0 ELSE 0 END
         + CASE WHEN $3 <> '' THEN COALESCE(ts_rank(ch.fts, to_tsquery('simple', $3)), 0) ELSE 0 END
       ) DESC
       LIMIT $5`,
      [spaceId, like, tokens || "", hasNotes ? noteIds : null, limit],
    );
    return (r.rows as unknown as SqlRow[]).map((row) => ({
      note_id: String(row.note_id),
      title: String(row.title ?? ""),
      space_id: String(row.space_id),
      text: String(row.text ?? ""),
      heading_path: row.heading_path,
      block_id: row.block_uuid,
      source_block_id: row.source_block_id,
    }));
  };
}
