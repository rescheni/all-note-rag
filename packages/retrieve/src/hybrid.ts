import {
  isCjkStopToken,
  queryContentTokens,
  stripCjkQueryStops,
  toFtsTokens,
  toTsQueryTokens,
} from "@note-hub/core";
import { cosine, formatVector, parseEmbedding, rrfMerge } from "./embed.ts";

export const UNKNOWN_ANSWER = "不知道";

export type RetrieveChunk = {
  note_id: string;
  title: string;
  space_id: string;
  path?: string;
  connection_id?: string;
  text: string;
  heading_path?: string | null;
  block_id?: string | null;
  source_block_id?: string | null;
  embedding?: number[] | null;
};

export type RetrieveHit = {
  note_id: string;
  title: string;
  space_id: string;
  path: string;
  connection_id: string;
  block_id: string;
  source_block_id: string;
  text: string;
  quote: string;
  rank: number;
  preview_url: string;
};

export type ChunkLoadOpts = {
  noteIds?: string[];
  limit?: number;
  userId?: string;
  role?: string;
};

export type LoadChunks = (
  spaceId: string,
  query: string,
  opts?: ChunkLoadOpts,
) => Promise<RetrieveChunk[]>;

export type LoadVectorChunks = (
  spaceId: string,
  queryEmbedding: number[],
  opts?: ChunkLoadOpts,
) => Promise<RetrieveChunk[]>;

export type HybridRetrieveOpts = {
  noteIds?: string[];
  limit?: number;
  /** In-memory corpus for tests; skips loadChunks. */
  chunks?: RetrieveChunk[];
  loadChunks?: LoadChunks;
  loadVectorChunks?: LoadVectorChunks;
  queryEmbedding?: number[];
  userId?: string;
  role?: string;
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
  const t = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)\]]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

/** Lexical overlap count for content tokens in title/body. */
export function contentTokenOverlap(
  query: string,
  chunk: { title: string; text: string; heading_path?: string | null },
): number {
  const content = queryContentTokens(query);
  if (!content.length) return 0;
  const title = chunk.title.toLowerCase();
  const body = `${chunk.heading_path ?? ""} ${chunk.text}`.toLowerCase();
  const titleTok = new Set(toFtsTokens(chunk.title).split(/\s+/).filter(Boolean));
  const bodyTok = new Set(
    toFtsTokens(`${chunk.heading_path ?? ""} ${chunk.text}`).split(/\s+/).filter(Boolean),
  );
  let hits = 0;
  for (const tok of content) {
    const t = tok.toLowerCase();
    if (titleTok.has(t) || bodyTok.has(t) || title.includes(t) || body.includes(t)) hits++;
  }
  return hits;
}

/** True when chunk shares only question-template bigrams, not content tokens. */
export function isTemplateOnlyMatch(
  query: string,
  chunk: { title: string; text: string; heading_path?: string | null },
): boolean {
  const content = queryContentTokens(query);
  if (!content.length) return false;
  if (contentTokenOverlap(query, chunk) > 0) return false;
  const blob = new Set(
    toFtsTokens(`${chunk.title} ${chunk.heading_path ?? ""} ${chunk.text}`)
      .split(/\s+/)
      .filter(Boolean),
  );
  const allQ = toFtsTokens(query).split(/\s+/).filter(Boolean);
  return allQ.some((t) => isCjkStopToken(t) && blob.has(t.toLowerCase()));
}

export function scoreChunk(query: string, chunk: RetrieveChunk): number {
  const q = query.trim();
  if (!q) return 0;
  const qLower = q.toLowerCase();
  const title = chunk.title.toLowerCase();
  const body = `${chunk.heading_path ?? ""} ${chunk.text}`.toLowerCase();
  const contentPhrase = stripCjkQueryStops(q).toLowerCase().replace(/\s+/g, "");
  const contentTokens = queryContentTokens(q);

  let score = 0;
  if (title.includes(qLower)) score += 2;
  if (body.includes(qLower)) score += 1;
  if (contentPhrase && contentPhrase !== qLower) {
    if (title.includes(contentPhrase)) score += 2.5;
    if (body.includes(contentPhrase)) score += 1.5;
  }

  if (contentTokens.length === 0) return score;

  const titleTok = new Set(toFtsTokens(chunk.title).split(/\s+/).filter(Boolean));
  const bodyTok = new Set(toFtsTokens(`${chunk.heading_path ?? ""} ${chunk.text}`).split(/\s+/).filter(Boolean));
  let contentHits = 0;
  for (const tok of contentTokens) {
    const t = tok.toLowerCase();
    const inTitle = titleTok.has(t) || title.includes(t);
    const inBody = bodyTok.has(t) || body.includes(t);
    if (inTitle) {
      score += 1.2;
      contentHits++;
    } else if (inBody) {
      score += 0.8;
      contentHits++;
    }
  }

  // Template-only overlap must not rank high when content tokens exist.
  if (contentHits === 0) {
    if (isTemplateOnlyMatch(q, chunk)) return 0;
    // Exact full-query substring already scored above; otherwise no lexical credit.
    return score > 0 ? score : 0;
  }
  return score;
}

export function hitKey(h: { note_id: string; source_block_id?: string | null; block_id?: string | null }): string {
  return `${h.note_id}::${(h.source_block_id ?? "").trim() || (h.block_id ?? "")}`;
}

function chunkToHit(ch: RetrieveChunk, rank: number): RetrieveHit {
  const sourceBlockId = (ch.source_block_id ?? "").trim();
  const blockId = sourceBlockId || (ch.block_id ?? "");
  return {
    note_id: ch.note_id,
    title: ch.title,
    space_id: ch.space_id,
    path: ch.path ?? "",
    connection_id: ch.connection_id ?? "",
    block_id: blockId,
    source_block_id: sourceBlockId,
    text: ch.text,
    quote: clipQuote(ch.text),
    rank,
    preview_url: previewUrl(ch.note_id, sourceBlockId),
  };
}

export async function hybridRetrieve(
  spaceId: string,
  queryText: string,
  opts: HybridRetrieveOpts = {},
): Promise<HybridRetrieveResult> {
  const q = queryText.trim();
  const limit = opts.limit ?? 12;
  if (!q) return { unknown: true, hits: [] };

  const fetchLimit = Math.max(limit * 5, 40);
  let chunks: RetrieveChunk[];
  if (opts.chunks) {
    chunks = opts.chunks;
  } else if (opts.loadChunks) {
    chunks = await opts.loadChunks(spaceId, q, {
      noteIds: opts.noteIds,
      limit: fetchLimit,
      userId: opts.userId,
      role: opts.role,
    });
  } else {
    chunks = [];
  }

  const noteFilter = opts.noteIds && opts.noteIds.length > 0 ? new Set(opts.noteIds) : null;
  const ftsHits: RetrieveHit[] = [];
  for (const ch of chunks) {
    if (ch.space_id !== spaceId) continue;
    if (noteFilter && !noteFilter.has(ch.note_id)) continue;
    const rank = scoreChunk(q, ch);
    if (rank <= 0) continue;
    ftsHits.push(chunkToHit(ch, rank));
  }
  ftsHits.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title, "zh"));

  const qEmb = opts.queryEmbedding;
  const vecHits: RetrieveHit[] = [];
  if (qEmb && qEmb.length) {
    if (opts.loadVectorChunks && !opts.chunks) {
      const vchunks = await opts.loadVectorChunks(spaceId, qEmb, {
        noteIds: opts.noteIds,
        limit: fetchLimit,
        userId: opts.userId,
        role: opts.role,
      });
      for (const ch of vchunks) {
        if (ch.space_id !== spaceId) continue;
        if (noteFilter && !noteFilter.has(ch.note_id)) continue;
        vecHits.push(chunkToHit(ch, 1));
      }
    } else {
      const scored: { hit: RetrieveHit; cos: number }[] = [];
      for (const ch of chunks) {
        if (ch.space_id !== spaceId) continue;
        if (noteFilter && !noteFilter.has(ch.note_id)) continue;
        const emb = ch.embedding;
        if (!emb?.length) continue;
        const cos = cosine(qEmb, emb);
        if (cos <= 0) continue;
        scored.push({ hit: chunkToHit(ch, cos), cos });
      }
      scored.sort((a, b) => b.cos - a.cos || a.hit.title.localeCompare(b.hit.title, "zh"));
      for (const s of scored) vecHits.push(s.hit);
    }
  }

  const contentTokens = queryContentTokens(q);
  // When the query has content tokens (感情), drop vector hits with zero
  // content-token overlap — including "pure semantic" demotions. Template-only
  // filter is not enough: embeddings still rank「什么是左值」/Kitex for「什么是感情」.
  let usableVec = vecHits;
  if (contentTokens.length > 0 && vecHits.length) {
    usableVec = vecHits.filter(
      (h) => contentTokenOverlap(q, { title: h.title, text: h.text }) > 0,
    );
  }

  const requireOverlap = contentTokens.length > 0;
  const ftsUsable = requireOverlap
    ? ftsHits.filter((h) => contentTokenOverlap(q, { title: h.title, text: h.text }) > 0)
    : ftsHits;

  if (!usableVec.length) {
    const hits = ftsUsable.slice(0, limit);
    if (hits.length === 0) return { unknown: true, hits: [] };
    return { unknown: false, hits };
  }

  // Prefer FTS lists that already match content; boost content-overlap keys in RRF order.
  const ftsBoosted = [...ftsUsable].sort((a, b) => {
    const ca = contentTokenOverlap(q, { title: a.title, text: a.text });
    const cb = contentTokenOverlap(q, { title: b.title, text: b.text });
    return cb - ca || b.rank - a.rank || a.title.localeCompare(b.title, "zh");
  });
  const vecBoosted = [...usableVec].sort((a, b) => {
    const ca = contentTokenOverlap(q, { title: a.title, text: a.text });
    const cb = contentTokenOverlap(q, { title: b.title, text: b.text });
    return cb - ca || a.title.localeCompare(b.title, "zh");
  });

  const byKey = new Map<string, RetrieveHit>();
  for (const h of [...ftsBoosted, ...vecBoosted]) {
    const k = hitKey(h);
    if (!byKey.has(k)) byKey.set(k, h);
  }
  const fused = rrfMerge(
    [ftsBoosted.map(hitKey), vecBoosted.map(hitKey)],
    60,
  );
  const hits: RetrieveHit[] = [];
  for (const row of fused) {
    const h = byKey.get(row.id);
    if (!h) continue;
    const overlap = contentTokens.length
      ? contentTokenOverlap(q, { title: h.title, text: h.text })
      : 0;
    if (requireOverlap && overlap <= 0) continue;
    // Content overlap boosts fused rank; zero-overlap vec already dropped.
    hits.push({ ...h, rank: row.score + overlap * 0.15 });
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title, "zh"));
  if (hits.length === 0) return { unknown: true, hits: [] };
  return { unknown: false, hits: hits.slice(0, limit) };
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
  path: string | null;
  connection_id: string | null;
  text: string;
  heading_path: string | null;
  block_uuid: string | null;
  source_block_id: string | null;
  embedding?: unknown;
};

function mapSqlRows(rows: SqlRow[]): RetrieveChunk[] {
  return rows.map((row) => ({
    note_id: String(row.note_id),
    title: String(row.title ?? ""),
    space_id: String(row.space_id),
    path: String(row.path ?? ""),
    connection_id: String(row.connection_id ?? ""),
    text: String(row.text ?? ""),
    heading_path: row.heading_path,
    block_id: row.block_uuid,
    source_block_id: row.source_block_id,
    embedding: parseEmbedding(row.embedding),
  }));
}

export function loadChunksViaSql(run: SqlQuery): LoadChunks {
  return async (spaceId, queryText, opts) => {
    // Prefer content-phrase ILIKE (感情) over full template query (什么是感情)
    // so we do not over-fetch / mis-rank on question-template substrings.
    const contentPhrase = stripCjkQueryStops(queryText).trim() || queryText.trim();
    const like = "%" + contentPhrase + "%";
    const tokens = toTsQueryTokens(queryText);
    const rawIds = opts?.noteIds ?? [];
    const noteIds = rawIds.filter((id) => UUID_RE.test(id));
    const hasNotes = noteIds.length > 0;
    const limit = opts?.limit ?? 40;
    const userId = opts?.userId ?? null;
    const role = opts?.role ?? null;
    const r = await run(
      `SELECT n.id AS note_id, n.title, n.space_id, n.path, n.connection_id, ch.text, ch.heading_path,
              b.id AS block_uuid, b.source_block_id, ch.embedding
       FROM chunks ch
       INNER JOIN notes n ON n.id = ch.note_id AND n.deleted_at IS NULL
       LEFT JOIN blocks b ON b.id = ch.block_id
       WHERE n.space_id = $1 AND ch.space_id = $1
         AND ($4::uuid[] IS NULL OR n.id = ANY($4::uuid[]))
         AND ($6::uuid IS NULL OR note_visible_to(n.acl_snapshot, $6::uuid, $7::text))
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
      [spaceId, like, tokens || "", hasNotes ? noteIds : null, limit, userId, role],
    );
    return mapSqlRows(r.rows as SqlRow[]);
  };
}

export function loadVectorChunksViaSql(run: SqlQuery): LoadVectorChunks {
  return async (spaceId, queryEmbedding, opts) => {
    const rawIds = opts?.noteIds ?? [];
    const noteIds = rawIds.filter((id) => UUID_RE.test(id));
    const hasNotes = noteIds.length > 0;
    const limit = opts?.limit ?? 40;
    const vec = formatVector(queryEmbedding);
    const userId = opts?.userId ?? null;
    const role = opts?.role ?? null;
    const r = await run(
      `SELECT n.id AS note_id, n.title, n.space_id, n.path, n.connection_id, ch.text, ch.heading_path,
              b.id AS block_uuid, b.source_block_id, ch.embedding
       FROM chunks ch
       INNER JOIN notes n ON n.id = ch.note_id AND n.deleted_at IS NULL
       LEFT JOIN blocks b ON b.id = ch.block_id
       WHERE n.space_id = $1 AND ch.space_id = $1
         AND ch.embedding IS NOT NULL
         AND ($3::uuid[] IS NULL OR n.id = ANY($3::uuid[]))
         AND ($5::uuid IS NULL OR note_visible_to(n.acl_snapshot, $5::uuid, $6::text))
       ORDER BY ch.embedding <=> $2::vector
       LIMIT $4`,
      [spaceId, vec, hasNotes ? noteIds : null, limit, userId, role],
    );
    return mapSqlRows(r.rows as SqlRow[]);
  };
}
