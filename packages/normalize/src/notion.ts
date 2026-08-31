import {
  canonicalizeBody,
  parseMarkdownLinks,
  sha256Hex,
  titleFromPath,
  type BlockType,
  type NormalizedAsset,
  type NormalizedBlock,
  type NormalizedLink,
  type NormalizedNote,
  type NotePayload,
} from "@note-hub/core";
import { extractBlocks, parseFrontmatter, stableMarkdown } from "./markdown.ts";

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;
}

function orderKey(i: number): string {
  return i.toString(36).padStart(4, "0");
}

export function canonicalNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

type Rich = {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
  text?: { content?: string; link?: { url?: string } | null };
};

export function richTextToMarkdown(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((item) => {
      const r = (item ?? {}) as Rich;
      const plain = r.plain_text ?? r.text?.content ?? "";
      let t = plain;
      const a = r.annotations ?? {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      const href = r.href ?? r.text?.link?.url ?? undefined;
      if (href) t = `[${plain}](${href})`;
      return t;
    })
    .join("");
}

export function richTextPlain(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((item) => {
      const r = (item ?? {}) as Rich;
      return r.plain_text ?? r.text?.content ?? "";
    })
    .join("");
}

function propRich(block: Dict, type: string): string {
  const data = asDict(block[type]);
  if (!data) return "";
  return richTextToMarkdown(data.rich_text ?? data.text);
}

function fileUrl(obj: unknown): { url: string; name: string } {
  const d = asDict(obj);
  if (!d) return { url: "", name: "" };
  if (d.type === "external") {
    const ext = asDict(d.external);
    return { url: String(ext?.url ?? ""), name: String(d.name ?? "") };
  }
  if (d.type === "file") {
    const f = asDict(d.file);
    return { url: String(f?.url ?? ""), name: String(d.name ?? "") };
  }
  return { url: String(d.url ?? ""), name: String(d.name ?? "") };
}

function flattenOne(p: Dict, type: string): unknown {
  switch (type) {
    case "title":
      return richTextPlain(p.title) || undefined;
    case "rich_text":
      return richTextPlain(p.rich_text) || undefined;
    case "select":
      return asDict(p.select)?.name ?? undefined;
    case "multi_select":
      return Array.isArray(p.multi_select)
        ? p.multi_select.map((x) => String(asDict(x)?.name ?? "")).filter(Boolean)
        : undefined;
    case "status":
      return asDict(p.status)?.name ?? undefined;
    case "number":
      return p.number ?? undefined;
    case "checkbox":
      return p.checkbox ?? undefined;
    case "url":
      return p.url ?? undefined;
    case "email":
      return p.email ?? undefined;
    case "phone_number":
      return p.phone_number ?? undefined;
    case "date": {
      const d = asDict(p.date);
      return d?.start ?? undefined;
    }
    case "people":
      return Array.isArray(p.people)
        ? p.people.map((x) => String(asDict(x)?.name ?? asDict(x)?.id ?? "")).filter(Boolean)
        : undefined;
    case "files":
      return Array.isArray(p.files)
        ? p.files
            .map((f) => {
              const d = asDict(f);
              return String(d?.name ?? asDict(d?.file)?.url ?? asDict(d?.external)?.url ?? "");
            })
            .filter(Boolean)
        : undefined;
    case "formula": {
      const f = asDict(p.formula);
      if (!f) return undefined;
      if (f.string != null) return f.string;
      if (f.number != null) return f.number;
      if (f.boolean != null) return f.boolean;
      return asDict(f.date)?.start;
    }
    case "relation":
      return Array.isArray(p.relation)
        ? p.relation.map((r) => canonicalNotionId(String(asDict(r)?.id ?? ""))).filter(Boolean)
        : undefined;
    case "created_time":
      return p.created_time;
    case "last_edited_time":
      return p.last_edited_time;
    case "unique_id": {
      const u = asDict(p.unique_id);
      if (!u) return undefined;
      return `${u.prefix ?? ""}${u.number ?? ""}` || undefined;
    }
    default:
      return undefined;
  }
}

export function flattenNotionProperties(properties: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = asDict(properties);
  if (!props) return out;
  for (const [name, raw] of Object.entries(props)) {
    const p = asDict(raw);
    if (!p) continue;
    const type = String(p.type ?? "");
    const v = flattenOne(p, type);
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[name] = v;
  }
  return out;
}

export function notionPageTitle(page: unknown): string {
  const obj = asDict(page);
  if (!obj) return "";
  if (Array.isArray(obj.title)) {
    const t = richTextPlain(obj.title);
    if (t) return t;
  }
  const props = asDict(obj.properties);
  if (props) {
    for (const prop of Object.values(props)) {
      const p = asDict(prop);
      if (p && p.type === "title") {
        const t = richTextPlain(p.title);
        if (t) return t;
      }
    }
  }
  return "";
}

function childrenOf(block: Dict): unknown[] {
  const c = block.children ?? block._children;
  return Array.isArray(c) ? c : [];
}

function notionBlockType(type: string): BlockType {
  if (type.startsWith("heading")) return "heading";
  if (type === "paragraph") return "para";
  if (type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do") return "list";
  if (type === "code") return "code";
  if (type === "quote" || type === "callout") return "quote";
  if (type === "table") return "table";
  if (type === "image" || type === "file" || type === "bookmark" || type === "embed" || type === "video") {
    return "embed";
  }
  return "unknown";
}

function tableToMarkdown(block: Dict): string {
  const rows = childrenOf(block);
  const cells: string[][] = [];
  for (const row of rows) {
    const r = asDict(row);
    if (!r) continue;
    const tr = asDict(r.table_row) ?? r;
    const rawCells = Array.isArray(tr.cells) ? tr.cells : [];
    cells.push(rawCells.map((c) => richTextToMarkdown(c).replace(/\|/g, "\\|")));
  }
  if (!cells.length) return "";
  const width = Math.max(...cells.map((c) => c.length), 1);
  const norm = cells.map((c) => {
    const row = [...c];
    while (row.length < width) row.push("");
    return row;
  });
  const head = norm[0];
  const sep = head.map(() => "---");
  const lines = [`| ${head.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (const row of norm.slice(1)) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function convertBlock(block: Dict, depth: number, outBlocks: NormalizedBlock[]): string[] {
  const type = String(block.type ?? "");
  const indent = "  ".repeat(depth);
  const id = canonicalNotionId(String(block.id ?? "")) || `notion-${outBlocks.length}`;
  const kids = childrenOf(block);
  const lines: string[] = [];
  let md = "";
  let text = "";
  let btype: BlockType = notionBlockType(type);
  let skipNative = false;

  switch (type) {
    case "paragraph": {
      md = propRich(block, "paragraph");
      text = richTextPlain(asDict(block.paragraph)?.rich_text);
      if (md) lines.push(indent + md);
      break;
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = Number(type.slice(-1));
      md = `${"#".repeat(level)} ${propRich(block, type)}`;
      text = richTextPlain(asDict(block[type])?.rich_text);
      lines.push(md);
      break;
    }
    case "bulleted_list_item": {
      md = `${indent}- ${propRich(block, "bulleted_list_item")}`;
      text = richTextPlain(asDict(block.bulleted_list_item)?.rich_text);
      lines.push(md);
      break;
    }
    case "numbered_list_item": {
      md = `${indent}1. ${propRich(block, "numbered_list_item")}`;
      text = richTextPlain(asDict(block.numbered_list_item)?.rich_text);
      lines.push(md);
      break;
    }
    case "to_do": {
      const checked = Boolean(asDict(block.to_do)?.checked);
      md = `${indent}- [${checked ? "x" : " "}] ${propRich(block, "to_do")}`;
      text = richTextPlain(asDict(block.to_do)?.rich_text);
      lines.push(md);
      break;
    }
    case "toggle": {
      md = `${indent}**${propRich(block, "toggle")}**`;
      text = richTextPlain(asDict(block.toggle)?.rich_text);
      lines.push(md);
      break;
    }
    case "quote": {
      md = `${indent}> ${propRich(block, "quote")}`;
      text = richTextPlain(asDict(block.quote)?.rich_text);
      lines.push(md);
      break;
    }
    case "callout": {
      const icon = String(asDict(asDict(block.callout)?.icon)?.emoji ?? "");
      const body = propRich(block, "callout");
      md = `${indent}> ${[icon, body].filter(Boolean).join(" ")}`;
      text = richTextPlain(asDict(block.callout)?.rich_text);
      lines.push(md);
      break;
    }
    case "code": {
      const lang = String(asDict(block.code)?.language ?? "");
      const code = propRich(block, "code");
      md = "```" + lang + "\n" + code + "\n```";
      text = richTextPlain(asDict(block.code)?.rich_text);
      lines.push(md);
      break;
    }
    case "divider":
      md = "---";
      lines.push("---");
      skipNative = true;
      break;
    case "image": {
      const img = asDict(block.image);
      const { url } = fileUrl(img);
      const cap = richTextToMarkdown(img?.caption);
      md = `![${cap}](${url})`;
      text = cap;
      lines.push(md);
      break;
    }
    case "file": {
      const f = asDict(block.file);
      const { url, name } = fileUrl(f);
      md = `[${name || "file"}](${url})`;
      text = name;
      lines.push(md);
      break;
    }
    case "bookmark": {
      const bm = asDict(block.bookmark);
      const url = String(bm?.url ?? "");
      const cap = richTextToMarkdown(bm?.caption);
      md = `[${cap || url}](${url})`;
      text = cap || url;
      lines.push(md);
      break;
    }
    case "child_page": {
      const title = String(asDict(block.child_page)?.title ?? "page");
      const href = `https://www.notion.so/${id}`;
      md = `[${title}](${href})`;
      text = title;
      lines.push(md);
      break;
    }
    case "table": {
      md = tableToMarkdown(block);
      text = md.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
      if (md) lines.push(md);
      break;
    }
    case "table_row":
      skipNative = true;
      break;
    default: {
      const fallback = propRich(block, type);
      if (fallback) {
        md = fallback;
        text = richTextPlain(asDict(block[type])?.rich_text);
        lines.push(indent + md);
      } else {
        skipNative = true;
      }
    }
  }

  if (!skipNative && (md || text)) {
    outBlocks.push({
      source_block_id: id,
      type: btype,
      text: (text || md).replace(/\s+/g, " ").trim(),
      markdown: md,
      order_key: orderKey(outBlocks.length),
      depth: type.startsWith("heading") ? Number(type.slice(-1)) || 1 : depth,
    });
  }

  if (type !== "table") {
    const childDepth =
      type === "bulleted_list_item" ||
      type === "numbered_list_item" ||
      type === "to_do" ||
      type === "toggle" ||
      type === "quote" ||
      type === "callout"
        ? depth + 1
        : depth;
    for (const ch of kids) {
      const d = asDict(ch);
      if (!d) continue;
      const chunk = convertBlock(d, childDepth, outBlocks);
      if (chunk.length) lines.push(...chunk);
    }
  }
  return lines;
}

export function notionBlocksToMarkdown(blocks: unknown[]): {
  markdown: string;
  blocks: NormalizedBlock[];
} {
  const outBlocks: NormalizedBlock[] = [];
  const parts: string[] = [];
  const list = Array.isArray(blocks) ? blocks : [];
  for (const raw of list) {
    const d = asDict(raw);
    if (!d) continue;
    const chunk = convertBlock(d, 0, outBlocks).join("\n").trimEnd();
    if (chunk) parts.push(chunk);
  }
  return { markdown: parts.join("\n\n"), blocks: outBlocks };
}

export function notionDatabaseToMarkdown(db: unknown): string {
  const obj = asDict(db) ?? {};
  const title = notionPageTitle(obj) || "database";
  const props = asDict(obj.properties) ?? {};
  const lines = [`# ${title}`, "", "## Properties"];
  for (const [name, raw] of Object.entries(props)) {
    const p = asDict(raw);
    const type = String(p?.type ?? p?.name ?? "unknown");
    const typed = p ? asDict(p[type]) : null;
    const options = Array.isArray(typed?.options)
      ? typed.options.map((o) => String(asDict(o)?.name ?? "")).filter(Boolean)
      : [];
    const extra = options.length ? `: ${options.join(", ")}` : "";
    lines.push(`- ${name} (${type})${extra}`);
  }
  return lines.join("\n");
}

function urlLinks(body: string): NormalizedLink[] {
  const links: NormalizedLink[] = [];
  for (const m of parseMarkdownLinks(body)) {
    if (/^https?:\/\//i.test(m.href) || m.href.startsWith("mailto:")) {
      links.push({ kind: "url", raw: m.raw });
    } else if (m.href.includes("notion.so") || m.href.startsWith("notion://")) {
      const hex = m.href.replace(/.*notion\.so\//, "").replace(/-/g, "").slice(0, 32);
      links.push({ kind: "ref", raw: m.raw, to_source_id: hex || undefined });
    }
  }
  return links;
}

function fromMarkdown(raw: string, payload: NotePayload, extraAssets: NormalizedAsset[]): NormalizedNote {
  const { frontmatter, body } = parseFrontmatter(raw, { lowercaseKeys: false });
  const markdown = stableMarkdown(frontmatter, body);
  const blocks = extractBlocks(body);
  const title =
    payload.title ||
    (typeof frontmatter.title === "string" && frontmatter.title) ||
    (typeof frontmatter.Name === "string" && frontmatter.Name) ||
    titleFromPath(payload.path);
  return {
    source_id: payload.source_id,
    path: payload.path,
    title,
    markdown,
    frontmatter,
    hash: sha256Hex(markdown),
    blocks,
    links: urlLinks(body),
    assets: extraAssets,
  };
}

export function normalizeNotionNote(
  payload: NotePayload,
  _connectionId: string,
  extraAssets: NormalizedAsset[] = [],
): NormalizedNote {
  const raw = typeof payload.raw === "string" ? payload.raw : new TextDecoder().decode(payload.raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Dict;
      const page = asDict(parsed.page) ?? parsed;
      const props = page.properties ?? parsed.properties;
      const frontmatter = flattenNotionProperties(props);
      if (parsed.object === "database" || page.object === "database") {
        frontmatter.object = "database";
      }
      const converted = Array.isArray(parsed.blocks)
        ? notionBlocksToMarkdown(parsed.blocks)
        : { markdown: typeof parsed.markdown === "string" ? parsed.markdown : "", blocks: [] as NormalizedBlock[] };
      let body = converted.markdown;
      if (!body && page.object === "database") body = notionDatabaseToMarkdown(page);
      if (typeof parsed.markdown === "string" && parsed.markdown.trim() && !converted.markdown) {
        body = parsed.markdown;
      }
      const markdown = stableMarkdown(frontmatter, body);
      const native = converted.blocks;
      const blocks = native.length ? native : extractBlocks(body);
      const title =
        payload.title ||
        notionPageTitle(page) ||
        (typeof frontmatter.title === "string" && frontmatter.title) ||
        titleFromPath(payload.path);
      return {
        source_id: payload.source_id,
        path: payload.path,
        title,
        markdown,
        frontmatter,
        hash: sha256Hex(markdown),
        blocks,
        links: urlLinks(body),
        assets: extraAssets,
      };
    } catch {
      /* fall through to markdown */
    }
  }
  return fromMarkdown(raw, payload, extraAssets);
}

export { canonicalizeBody };
