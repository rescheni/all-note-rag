import YAML from "yaml";
import {
  canonicalizeBody,
  isAssetTarget,
  parseMarkdownLinks,
  parseWikiLinks,
  posixVaultPath,
  sha256Hex,
  shortFingerprint,
  titleFromPath,
  type NormalizedAsset,
  type NormalizedBlock,
  type NormalizedLink,
  type NormalizedNote,
  type NotePayload,
  type BlockType,
} from "@note-hub/core";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

function lowerKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[key] = lowerKeys(v as Record<string, unknown>);
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function parseFrontmatter(
  raw: string,
  opts?: { lowercaseKeys?: boolean },
): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const rest = text.slice(3);
  const nl = rest.startsWith("\n") || rest.startsWith("\r\n") ? rest.replace(/^\r?\n/, "") : rest;
  const end = nl.search(/\r?\n---[ \t]*\r?\n/);
  if (end < 0) {
    const end2 = nl.search(/\r?\n---[ \t]*$/);
    if (end2 < 0) return { frontmatter: {}, body: text };
  }
  const m = nl.match(/^([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  let parsed: unknown = {};
  try {
    parsed = YAML.parse(m[1]) ?? {};
  } catch {
    parsed = {};
  }
  const rawFm =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const fm = opts?.lowercaseKeys === false ? rawFm : lowerKeys(rawFm);
  return { frontmatter: fm, body: m[2] };
}

export function stableMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const bodyPart = canonicalizeBody(body);
  if (!frontmatter || Object.keys(frontmatter).length === 0) return bodyPart;
  const sorted = sortKeys(frontmatter) as Record<string, unknown>;
  const yaml = YAML.stringify(sorted, { sortMapEntries: true }).replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return `---\n${yaml}\n---\n${bodyPart}`;
}

function slugPart(s: string): string {
  const t = s.trim().toLowerCase().replace(/\s+/g, "-");
  return t.replace(/[^\w\u3400-\u9fff-]/g, "").slice(0, 48) || "x";
}

function orderKey(i: number): string {
  return i.toString(36).padStart(4, "0");
}

type OpenBlock = { type: BlockType; lines: string[]; depth: number; headingPath: string[] };

function flush(open: OpenBlock | null, blocks: NormalizedBlock[], counters: Record<string, number>): void {
  if (!open) return;
  const markdown = open.lines.join("\n").trimEnd();
  if (!markdown.trim()) return;
  const text = markdown
    .replace(/^#{1,6}\s+/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, a: string, alias?: string) => alias || a)
    .replace(/[*_`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const key = `${open.type}`;
  counters[key] = (counters[key] ?? 0) + 1;
  const idx = counters[key] - 1;
  const hp = open.headingPath.map(slugPart).join("/") || "root";
  const source_block_id = `${hp}/${open.type}${idx}-${shortFingerprint(text || markdown)}`;
  blocks.push({
    source_block_id,
    type: open.type,
    text,
    markdown,
    order_key: orderKey(blocks.length),
    depth: open.depth,
  });
}

export function extractBlocks(body: string): NormalizedBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: NormalizedBlock[] = [];
  const counters: Record<string, number> = {};
  const headingPath: string[] = [];
  let open: OpenBlock | null = null;
  let inCode = false;
  let codeFence = "";

  const start = (type: BlockType, depth: number, line: string, hp: string[]) => {
    flush(open, blocks, counters);
    open = { type, lines: [line], depth, headingPath: [...hp] };
  };

  for (const line of lines) {
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeFence = fence[1];
        start("code", headingPath.length, line, headingPath);
      } else if (line.startsWith(codeFence)) {
        open?.lines.push(line);
        flush(open, blocks, counters);
        open = null;
        inCode = false;
        codeFence = "";
      } else {
        open?.lines.push(line);
      }
      continue;
    }
    if (inCode) {
      open?.lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const depth = heading[1].length;
      headingPath.length = depth - 1;
      headingPath.push(heading[2].trim());
      start("heading", depth, line, headingPath);
      flush(open, blocks, counters);
      open = null;
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (open?.type === "quote") open.lines.push(line);
      else start("quote", headingPath.length, line, headingPath);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      if (open?.type === "list") open.lines.push(line);
      else start("list", headingPath.length, line, headingPath);
      continue;
    }
    if (/^\s*\|.+\|/.test(line)) {
      if (open?.type === "table") open.lines.push(line);
      else start("table", headingPath.length, line, headingPath);
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flush(open, blocks, counters);
      open = null;
      continue;
    }
    if (!line.trim()) {
      flush(open, blocks, counters);
      open = null;
      continue;
    }
    if (open?.type === "para") open.lines.push(line);
    else start("para", headingPath.length, line, headingPath);
  }
  flush(open, blocks, counters);
  inCode = false;
  return blocks;
}

export function extractLinks(body: string, notePath: string, connectionId: string): NormalizedLink[] {
  const links: NormalizedLink[] = [];
  for (const w of parseWikiLinks(body)) {
    const kind = w.embed ? (isAssetTarget(w.target) ? "embed" : "embed") : "ref";
    const targetPath = posixVaultPath(w.target.replace(/\\/g, "/"));
    const withExt =
      isAssetTarget(targetPath) || targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
    links.push({
      kind: isAssetTarget(w.target) ? "embed" : kind,
      raw: w.raw,
      to_path: withExt,
      to_source_id: `obsidian://${connectionId}/${withExt}`,
    });
  }
  for (const m of parseMarkdownLinks(body)) {
    if (/^https?:\/\//i.test(m.href) || m.href.startsWith("mailto:")) {
      links.push({ kind: "url", raw: m.raw });
      continue;
    }
    const href = m.href.split("#")[0].split("?")[0];
    const dir = posixVaultPath(notePath).split("/").slice(0, -1).join("/");
    let resolved = href.replace(/^\.\//, "");
    if (!resolved.startsWith("/")) resolved = dir ? `${dir}/${resolved}` : resolved;
    resolved = posixVaultPath(resolved.replace(/\/{2,}/g, "/"));
    const kind = m.embed || isAssetTarget(resolved) ? "embed" : "ref";
    const withExt =
      isAssetTarget(resolved) || resolved.endsWith(".md") ? resolved : `${resolved}.md`;
    links.push({
      kind,
      raw: m.raw,
      to_path: withExt,
      to_source_id: `obsidian://${connectionId}/${withExt}`,
    });
  }
  return links;
}

export function referencedAssetPaths(body: string, notePath: string): string[] {
  const set = new Set<string>();
  const dir = posixVaultPath(notePath).split("/").slice(0, -1).join("/");
  const add = (t: string) => {
    let p = t.split("#")[0].split("|")[0].trim().replace(/\\/g, "/");
    p = p.replace(/^\.\//, "");
    if (!p.startsWith("/") && dir && !p.includes("/") && isAssetTarget(p)) {
      // keep as-is first, also try dir-relative and vault-root
      set.add(posixVaultPath(p));
      set.add(posixVaultPath(`${dir}/${p}`));
      return;
    }
    if (!p.startsWith("/") && !isAssetTarget(p) === false) {
      /* continue */
    }
    if (!p.startsWith("/") && dir) set.add(posixVaultPath(`${dir}/${p}`));
    set.add(posixVaultPath(p));
  };
  for (const w of parseWikiLinks(body)) {
    if (isAssetTarget(w.target)) add(w.target);
  }
  for (const m of parseMarkdownLinks(body)) {
    if (isAssetTarget(m.href) || m.embed) add(m.href);
  }
  return [...set];
}

export function normalizeObsidianNote(
  payload: NotePayload,
  connectionId: string,
  extraAssets: NormalizedAsset[] = [],
): NormalizedNote {
  const raw = typeof payload.raw === "string" ? payload.raw : new TextDecoder().decode(payload.raw);
  const path = posixVaultPath(payload.path);
  const { frontmatter, body } = parseFrontmatter(raw);
  const markdown = stableMarkdown(frontmatter, body);
  const hash = sha256Hex(markdown);
  const blocks = extractBlocks(body);
  const links = extractLinks(body, path, connectionId);
  const title =
    (typeof frontmatter.title === "string" && frontmatter.title) || payload.title || titleFromPath(path);
  return {
    source_id: payload.source_id,
    path,
    title,
    markdown,
    frontmatter,
    hash,
    blocks,
    links,
    assets: extraAssets,
  };
}

