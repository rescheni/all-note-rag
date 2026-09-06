/** SiYuan hex codepoints (`1f618`, `1f573-fe0f`) or already-emoji → display string. */
export function siyuanIconToEmoji(code: string): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  if (!/^[0-9a-fA-F]{2,}(-[0-9a-fA-F]{2,})*$/.test(raw)) return raw;
  const cps: number[] = [];
  for (const part of raw.split("-")) {
    const n = parseInt(part, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) continue;
    cps.push(n);
  }
  if (!cps.length) return "";
  try {
    return String.fromCodePoint(...cps);
  } catch {
    return "";
  }
}
