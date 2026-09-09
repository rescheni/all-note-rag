/**
 * CJK FTS helper: keep latin tokens; emit overlapping bigrams for CJK runs.
 * Used when zhparser / pg_jieba are unavailable (simple + bigram fallback).
 *
 * Query side strips Chinese question templates / stop phrases so FTS and
 * lexical scoring prefer content tokens (感情) over template bigrams (什么/么是).
 *
 * Query-side covering bigrams drop interior bridge tokens (索二) that only exist
 * when a multi-character run is contiguous; index-side still stores all overlaps.
 */

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** Longer phrases first so 「请问一下」wins over 「请问」/「一下」. */
export const CJK_QUERY_STOP_PHRASES = [
  "请问一下",
  "有没有",
  "为什么",
  "怎么样",
  "是什么",
  "叫什么",
  "什么是",
  "什么叫",
  "是否是",
  "怎么",
  "如何",
  "怎样",
  "为何",
  "是否",
  "请问",
  "一下",
] as const;

let stopBigramCache: Set<string> | null = null;

type TokenRun =
  | { kind: "cjk"; run: string }
  | { kind: "latin"; token: string };

/** Split text into CJK runs and latin tokens (punctuation skipped). */
function lexRuns(text: string): TokenRun[] {
  const s = text.normalize("NFKC");
  const out: TokenRun[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (CJK.test(ch)) {
      let j = i;
      while (j < s.length && CJK.test(s[j]!)) j++;
      out.push({ kind: "cjk", run: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      out.push({ kind: "latin", token: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Index-side: all overlapping bigrams for a CJK run. */
function overlappingBigrams(run: string): string[] {
  if (run.length === 0) return [];
  if (run.length === 1) return [run];
  const out: string[] = [];
  for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
  return out;
}

/**
 * Query-side covering bigrams for a CJK run.
 * Keep even-index overlapping bigrams plus the final bigram so the run stays
 * covered end-to-end, but drop interior bridge bigrams (e.g. 索二 in 搜索二叉树)
 * that rarely appear unless the whole run is contiguous in the document.
 */
export function coveringBigrams(run: string): string[] {
  if (run.length === 0) return [];
  if (run.length === 1) return [run];
  if (run.length === 2) return [run];
  const all = overlappingBigrams(run);
  const keep = new Set<number>();
  for (let i = 0; i < all.length; i += 2) keep.add(i);
  keep.add(all.length - 1);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => all[i]!);
}

function tokenizeRaw(text: string): string[] {
  const out: string[] = [];
  for (const part of lexRuns(text)) {
    if (part.kind === "latin") out.push(part.token);
    else out.push(...overlappingBigrams(part.run));
  }
  return out;
}

/** Query-side tokens: covering bigrams per CJK run (bridges dropped). */
function tokenizeQuery(text: string): string[] {
  const out: string[] = [];
  for (const part of lexRuns(text)) {
    if (part.kind === "latin") out.push(part.token);
    else out.push(...coveringBigrams(part.run));
  }
  return out;
}

function sanitizeToken(t: string): string {
  return t.replace(/[^A-Za-z0-9_\u3400-\u9fff]/g, "");
}

function uniquePreserve(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Document / index tokenization (all bigrams; do not strip stops). */
export function toFtsTokens(text: string): string {
  return tokenizeRaw(text).join(" ");
}

/** Bigrams that come from query-side stop phrases (什么/么是/…). */
export function cjkStopBigrams(): Set<string> {
  if (stopBigramCache) return stopBigramCache;
  const set = new Set<string>();
  for (const phrase of CJK_QUERY_STOP_PHRASES) {
    for (const t of tokenizeRaw(phrase)) set.add(t);
  }
  stopBigramCache = set;
  return set;
}

/**
 * Remove Chinese question templates from a query string.
 * Repeated until stable so stacked fillers collapse.
 */
export function stripCjkQueryStops(query: string): string {
  let s = query.normalize("NFKC");
  let prev = "";
  while (s !== prev) {
    prev = s;
    for (const phrase of CJK_QUERY_STOP_PHRASES) {
      if (s.includes(phrase)) s = s.split(phrase).join(" ");
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Content-bearing query tokens for search / ask.
 * Prefers tokens after stop-phrase stripping; falls back to all tokens minus
 * stop bigrams; finally to raw tokens if the query is only templates.
 * Uses covering bigrams (not full overlaps) so bridge tokens are not required.
 */
export function queryContentTokens(query: string): string[] {
  const stripped = stripCjkQueryStops(query);
  const fromStripped = uniquePreserve(
    tokenizeQuery(stripped).map(sanitizeToken).filter(Boolean),
  );
  if (fromStripped.length > 0) return fromStripped;

  const stops = cjkStopBigrams();
  const all = uniquePreserve(tokenizeQuery(query).map(sanitizeToken).filter(Boolean));
  const withoutStops = all.filter((t) => !stops.has(t));
  return withoutStops.length > 0 ? withoutStops : all;
}

/** True when token is a known query-template bigram. */
export function isCjkStopToken(token: string): boolean {
  return cjkStopBigrams().has(token.toLowerCase());
}

/**
 * Build a `simple` to_tsquery fragment from content tokens.
 * Covering bigrams are AND-ed; interior bridges like 索二 are omitted so
 * 「搜索二叉树」does not require a rare contiguous bridge token.
 * Stop phrases remain stripped (什么是感情 → 感情).
 */
export function toTsQueryTokens(query: string): string {
  const tokens = queryContentTokens(query);
  return tokens.join(" & ");
}
