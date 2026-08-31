import { DEFAULT_OBSIDIAN_IGNORE } from "./types.ts";
import { posixVaultPath } from "./source-id.ts";

export function stripPrefix(key: string, remotePrefix: string): string {
  const prefix = posixVaultPath(remotePrefix).replace(/\/+$/, "");
  let k = posixVaultPath(key);
  if (prefix && (k === prefix || k.startsWith(prefix + "/"))) {
    k = k.slice(prefix.length).replace(/^\/+/, "");
  }
  return k;
}

export function shouldIgnore(relPath: string, ignore: readonly string[] = DEFAULT_OBSIDIAN_IGNORE): boolean {
  const rel = posixVaultPath(relPath);
  if (!rel) return true;
  const parts = rel.split("/");
  for (const rule of ignore) {
    const r = rule.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!r) continue;
    if (rel === r || rel.startsWith(r + "/")) return true;
    if (parts.includes(r) || parts.includes(r.replace(/\/$/, ""))) return true;
    if (parts[0] === r || parts[0] === `.${r}`) return true;
  }
  if (parts.includes(".obsidian") || parts.includes(".trash")) return true;
  return false;
}

export function isMarkdownPath(relPath: string): boolean {
  return posixVaultPath(relPath).toLowerCase().endsWith(".md");
}
