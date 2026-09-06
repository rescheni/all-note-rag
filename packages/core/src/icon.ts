/**
 * SiYuan stores emoji icons as hyphen-separated hex codepoints
 * (e.g. `1f618`, `1f573-fe0f`, `1f1f0-1f1ec`). Notion/Obsidian may
 * already store the emoji character. Convert either form to a display string.
 */
export function siyuanIconToEmoji(code: string): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  // Hex codepoints only (SiYuan). Anything else is treated as already-emoji.
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
