/**
 * CJK FTS helper: keep latin tokens; emit overlapping bigrams for CJK runs.
 * Used when zhparser / pg_jieba are unavailable (simple + bigram fallback).
 */
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export function toFtsTokens(text: string): string {
  const s = text.normalize("NFKC");
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < s.length && CJK.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length === 1) out.push(run);
      else {
        for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
      }
      i = j;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push(s.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    i++;
  }
  return out.join(" ");
}

export function toTsQueryTokens(query: string): string {
  const tokens = toFtsTokens(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[^A-Za-z0-9_\u3400-\u9fff]/g, ""))
    .filter(Boolean);
  return tokens.join(" & ");
}
