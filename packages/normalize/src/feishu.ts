import {
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

function elementsText(elements: unknown): string {
  if (!Array.isArray(elements)) return "";
  return elements
    .map((el) => {
      const d = asDict(el);
      if (!d) return "";
      const run = asDict(d.text_run);
      if (run) {
        let t = String(run.content ?? "");
        const st = asDict(run.text_element_style) ?? {};
        if (st.inline_code) t = `\`${t}\``;
        if (st.bold) t = `**${t}**`;
        if (st.italic) t = `*${t}*`;
        if (st.strikethrough) t = `~~${t}~~`;
        const link = asDict(st.link);
        const url = link ? String(link.url ?? "") : "";
        if (url) {
          let href = url;
          try {
            href = decodeURIComponent(url);
          } catch {
            href = url;
          }
          t = `[${String(run.content ?? "")}](${href})`;
        }
        return t;
      }
      const mention = asDict(d.mention_doc);
      if (mention) return String(mention.title ?? mention.token ?? "");
      const eq = asDict(d.equation);
      if (eq) return `$${String(eq.content ?? "")}$`;
      return "";
    })
    .join("");
}

const BLOCK_KEY: Record<number, string> = {
  1: "page",
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  7: "heading5",
  8: "heading6",
  9: "heading7",
  10: "heading8",
  11: "heading9",
  12: "bullet",
  13: "ordered",
  14: "code",
  15: "quote",
  17: "todo",
  19: "callout",
  22: "divider",
  23: "file",
  27: "image",
  31: "table",
};

function blockElements(block: Dict): unknown {
  const t = Number(block.block_type);
  const key = BLOCK_KEY[t];
  if (!key) return [];
  const data = asDict(block[key]);
  return data?.elements ?? [];
}

function feishuBlockType(t: number): BlockType {
  if (t >= 3 && t <= 11) return "heading";
  if (t === 2) return "para";
  if (t === 12 || t === 13 || t === 17) return "list";
  if (t === 14) return "code";
  if (t === 15 || t === 19) return "quote";
  if (t === 31) return "table";
  if (t === 27 || t === 23) return "embed";
  return "unknown";
}

export function feishuBlocksToMarkdown(blocks: unknown[]): {
  markdown: string;
  title: string;
  blocks: NormalizedBlock[];
} {
  const list = Array.isArray(blocks) ? blocks : [];
  let title = "";
  const lines: string[] = [];
  const out: NormalizedBlock[] = [];
  for (const raw of list) {
    const b = asDict(raw);
    if (!b) continue;
    const t = Number(b.block_type);
    const id = String(b.block_id ?? `feishu-${out.length}`);
    let md = "";
    let text = "";
    if (t === 1) {
      title = elementsText(asDict(b.page)?.elements);
      continue;
    }
    if (t === 2) {
      text = elementsText(asDict(b.text)?.elements);
      md = text;
    } else if (t >= 3 && t <= 11) {
      const level = Math.min(t - 2, 6);
      text = elementsText(blockElements(b));
      md = `${"#".repeat(level)} ${text}`;
    } else if (t === 12) {
      text = elementsText(asDict(b.bullet)?.elements);
      md = `- ${text}`;
    } else if (t === 13) {
      text = elementsText(asDict(b.ordered)?.elements);
      md = `1. ${text}`;
    } else if (t === 14) {
      text = elementsText(asDict(b.code)?.elements);
      const lang = String(asDict(asDict(b.code)?.style)?.language ?? "");
      md = "```" + (lang && !/^\d+$/.test(lang) ? lang : "") + "\n" + text + "\n```";
    } else if (t === 15) {
      text = elementsText(asDict(b.quote)?.elements);
      md = `> ${text}`;
    } else if (t === 17) {
      const done = Boolean(asDict(asDict(b.todo)?.style)?.done);
      text = elementsText(asDict(b.todo)?.elements);
      md = `- [${done ? "x" : " "}] ${text}`;
    } else if (t === 19) {
      text = elementsText(asDict(b.callout)?.elements);
      md = `> ${text}`;
    } else if (t === 22) {
      md = "---";
    } else if (t === 27) {
      const img = asDict(b.image);
      const token = String(img?.token ?? "");
      const name = String(img?.name ?? "").trim() || (token ? `${token}.png` : "image.png");
      md = `![](${name})`;
      text = name;
    } else if (t === 23) {
      const file = asDict(b.file);
      const token = String(file?.token ?? "");
      const name = String(file?.name ?? "").trim() || token || "file";
      md = `[${name}](${name})`;
      text = name;
    } else {
      text = elementsText(blockElements(b));
      md = text;
    }
    if (!md.trim()) continue;
    lines.push(md);
    if (md !== "---") {
      out.push({
        source_block_id: id,
        type: feishuBlockType(t),
        text: (text || md).replace(/\s+/g, " ").trim(),
        markdown: md,
        order_key: orderKey(out.length),
        depth: t >= 3 && t <= 11 ? Math.min(t - 2, 6) : 0,
      });
    }
  }
  return { markdown: lines.join("\n\n"), title, blocks: out };
}

function urlLinks(body: string): NormalizedLink[] {
  const links: NormalizedLink[] = [];
  for (const m of parseMarkdownLinks(body)) {
    if (/^https?:\/\//i.test(m.href) || m.href.startsWith("mailto:")) {
      links.push({ kind: "url", raw: m.raw });
    }
  }
  return links;
}

export function normalizeFeishuNote(
  payload: NotePayload,
  _connectionId: string,
  extraAssets: NormalizedAsset[] = [],
): NormalizedNote {
  const raw = typeof payload.raw === "string" ? payload.raw : new TextDecoder().decode(payload.raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Dict;
      const items = Array.isArray(parsed.blocks)
        ? parsed.blocks
        : Array.isArray(parsed.items)
          ? parsed.items
          : [];
      const converted = feishuBlocksToMarkdown(items);
      const body =
        converted.markdown || (typeof parsed.markdown === "string" ? parsed.markdown : "");
      const frontmatter: Record<string, unknown> = {};
      if (parsed.obj_token) frontmatter.obj_token = parsed.obj_token;
      const markdown = stableMarkdown(frontmatter, body);
      const blocks = converted.blocks.length ? converted.blocks : extractBlocks(body);
      const title = payload.title || converted.title || titleFromPath(payload.path);
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
      /* markdown */
    }
  }
  const { frontmatter, body } = parseFrontmatter(raw, { lowercaseKeys: false });
  const markdown = stableMarkdown(frontmatter, body);
  return {
    source_id: payload.source_id,
    path: payload.path,
    title: payload.title || titleFromPath(payload.path),
    markdown,
    frontmatter,
    hash: sha256Hex(markdown),
    blocks: extractBlocks(body),
    links: urlLinks(body),
    assets: extraAssets,
  };
}

export type FeishuMediaRef = { token: string; name: string; kind: "image" | "file" };

export function feishuMediaRefs(blocks: unknown[]): FeishuMediaRef[] {
  const out: FeishuMediaRef[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const b = asDict(raw);
    if (!b) continue;
    const t = Number(b.block_type);
    if (t === 27) {
      const img = asDict(b.image);
      const token = String(img?.token ?? "").trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      const name = String(img?.name ?? "").trim() || `${token}.png`;
      out.push({ token, name, kind: "image" });
    } else if (t === 23) {
      const file = asDict(b.file);
      const token = String(file?.token ?? "").trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      const name = String(file?.name ?? "").trim() || token;
      out.push({ token, name, kind: "file" });
    }
  }
  return out;
}
