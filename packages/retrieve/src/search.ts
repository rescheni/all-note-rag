import { toFtsTokens } from "@note-hub/core";
import { cosine } from "./embed.ts";
import { clipQuote, previewUrl, scoreChunk } from "./hybrid.ts";

export const SIMILAR_LIMIT = 8;
export const SOURCE_RESULT_LIMIT = 30;

export type SourceSearchHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  source_block_id: string | null;
  preview_url: string;
  match: "keyword" | "path";
};

export type SimilarSearchHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number;
};

export type SearchCorpusChunk = {
  text: string;
  source_block_id?: string | null;
  embedding?: number[] | null;
};

export type SearchCorpusNote = {
  note_id: string;
  title: string;
  path: string;
  space_id: string;
  markdown?: string | null;
  chunks?: SearchCorpusChunk[];
};

export type SearchSourcesOpts = {
  queryEmbedding?: number[];
  resultLimit?: number;
  similarLimit?: number;
};

function includesFold(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function sourceMatch(
  q: string,
  note: SearchCorpusNote,
): { match: "keyword" | "path"; snippet: string; source_block_id: string | null; rank: number } | null {
  const qTrim = q.trim();
  if (!qTrim) return null;
  const chunks = note.chunks ?? [];
  const markdown = note.markdown ?? "";
  const pathHit = includesFold(note.path, qTrim);
  let bestChunk: SearchCorpusChunk | null = null;
  let bestRank = 0;
  for (const ch of chunks) {
    const rank = scoreChunk(qTrim, {
      note_id: note.note_id,
      title: note.title,
      space_id: note.space_id,
      text: ch.text,
      source_block_id: ch.source_block_id,
    });
    if (rank > bestRank) {
      bestRank = rank;
      bestChunk = ch;
    }
  }
  const titleHit = includesFold(note.title, qTrim);
  const bodyHit =
    includesFold(markdown, qTrim) || chunks.some((c) => includesFold(c.text, qTrim));
  const tokens = toFtsTokens(qTrim).split(/\s+/).filter(Boolean);
  let tokenHit = false;
  if (tokens.length) {
    const blob = toFtsTokens(`${note.title} ${note.path} ${markdown} ${chunks.map((c) => c.text).join(" ")}`);
    const set = new Set(blob.split(/\s+/).filter(Boolean));
    tokenHit = tokens.some((t) => set.has(t));
  }
  if (!pathHit && !titleHit && !bodyHit && !tokenHit && bestRank <= 0) return null;
  const snippetSrc = bestChunk?.text || markdown || note.title;
  return {
    match: pathHit ? "path" : "keyword",
    snippet: clipQuote(snippetSrc, 180),
    source_block_id: (bestChunk?.source_block_id ?? null) || null,
    rank: (pathHit ? 2 : 0) + (titleHit ? 1.5 : 0) + bestRank,
  };
}

export function similarToEmbedding(
  spaceId: string,
  embedding: number[],
  notes: SearchCorpusNote[],
  opts?: { excludeIds?: Iterable<string>; limit?: number },
): SimilarSearchHit[] {
  if (!embedding.length) return [];
  const exclude = new Set(opts?.excludeIds ?? []);
  const limit = opts?.limit ?? SIMILAR_LIMIT;
  const scored: SimilarSearchHit[] = [];
  for (const note of notes) {
    if (note.space_id !== spaceId) continue;
    if (exclude.has(note.note_id)) continue;
    let best = -1;
    let snippet = note.markdown ?? note.title;
    for (const ch of note.chunks ?? []) {
      const emb = ch.embedding;
      if (!emb?.length) continue;
      const cos = cosine(embedding, emb);
      if (cos > best) {
        best = cos;
        snippet = ch.text || snippet;
      }
    }
    if (best <= 0) continue;
    scored.push({
      note_id: note.note_id,
      title: note.title,
      path: note.path,
      snippet: clipQuote(snippet, 180),
      preview_url: previewUrl(note.note_id),
      score: best,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh"));
  return scored.slice(0, limit);
}

export function searchSourcesAndSimilar(
  spaceId: string,
  queryText: string,
  notes: SearchCorpusNote[],
  opts: SearchSourcesOpts = {},
): { query: string; results: SourceSearchHit[]; similar: SimilarSearchHit[] } {
  const query = queryText.trim();
  const resultLimit = opts.resultLimit ?? SOURCE_RESULT_LIMIT;
  if (!query) return { query: queryText, results: [], similar: [] };

  const inSpace = notes.filter((n) => n.space_id === spaceId);
  const ranked: { hit: SourceSearchHit; rank: number }[] = [];
  for (const note of inSpace) {
    const m = sourceMatch(query, note);
    if (!m) continue;
    ranked.push({
      rank: m.rank,
      hit: {
        note_id: note.note_id,
        title: note.title,
        path: note.path,
        snippet: m.snippet,
        source_block_id: m.source_block_id,
        preview_url: previewUrl(note.note_id, m.source_block_id),
        match: m.match,
      },
    });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.hit.title.localeCompare(b.hit.title, "zh"));
  const results = ranked.slice(0, resultLimit).map((r) => r.hit);
  const exclude = results.map((r) => r.note_id);
  const qEmb = opts.queryEmbedding;
  const similar =
    qEmb && qEmb.length
      ? similarToEmbedding(spaceId, qEmb, inSpace, {
          excludeIds: exclude,
          limit: opts.similarLimit ?? SIMILAR_LIMIT,
        })
      : [];
  return { query, results, similar };
}
