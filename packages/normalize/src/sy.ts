import {
  canonicalizeBody,
  sha256Hex,
  titleFromPath,
  type BlockType,
  type NormalizedAsset,
  type NormalizedBlock,
  type NormalizedLink,
  type NormalizedNote,
  type NotePayload,
} from "@note-hub/core";

type SyNode = Record<string, unknown>;

function asNode(v: unknown): SyNode | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as SyNode) : null;
}

function nodeType(n: SyNode): string {
  const t = String(n.Type ?? n.type ?? "");
  return t.replace(/^Node/, "");
}

function nodeId(n: SyNode): string {
  if (typeof n.ID === "string" && n.ID) return n.ID;
  if (typeof n.id === "string" && n.id) return n.id;
  const p = (n.Properties ?? n.properties) as Record<string, unknown> | undefined;
  if (p && typeof p.id === "string" && p.id) return p.id;
  return "";
}

function childrenOf(n: SyNode): SyNode[] {
  const c = n.Children ?? n.children;
  return Array.isArray(c) ? c.filter((x) => x && typeof x === "object") as SyNode[] : [];
}

function propsOf(n: SyNode): Record<string, unknown> {
  const p = n.Properties ?? n.properties;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function dataOf(n: SyNode): string {
  return typeof n.Data === "string" ? n.Data : typeof n.data === "string" ? n.data : "";
}

function orderKey(i: number): string {
  return i.toString(36).padStart(4, "0");
}

function isBlockRef(n: SyNode): boolean {
  const t = nodeType(n);
  if (t === "BlockRef") return true;
  if (t === "TextMark") {
    const mark = String(n.TextMarkType ?? n.textMarkType ?? "");
    return mark.split(/\s+/).includes("block-ref");
  }
  return false;
}

function blockRefId(n: SyNode): string {
  const direct = String(n.TextMarkBlockRefID ?? n.textMarkBlockRefID ?? "").trim();
  if (direct) return direct;
  const p = propsOf(n);
  const fromProps = String(p.id ?? p.block_id ?? "").trim();
  if (nodeType(n) === "BlockRef" && fromProps) return fromProps;
  for (const ch of childrenOf(n)) {
    const ct = nodeType(ch);
    if (ct === "BlockRefID" || ct === "TextMark") {
      const id = dataOf(ch) || String(ch.TextMarkBlockRefID ?? "").trim();
      if (id) return id;
    }
    const nested = blockRefId(ch);
    if (nested) return nested;
  }
  return "";
}

function htmlImgsToMarkdown(html: string): string {
  if (!html || !/<img\b/i.test(html)) return "";
  const out: string[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = (srcM?.[1] || srcM?.[2] || srcM?.[3] || "").trim();
    if (!src) continue;
    const altM = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const alt = (altM?.[1] || altM?.[2] || altM?.[3] || "image").trim() || "image";
    out.push(`![${alt}](${src})`);
  }
  return out.join("\n\n");
}

function imageNodeToMarkdown(n: SyNode): string {
  let alt = "";
  let dest = "";
  const walk = (node: SyNode) => {
    const t = nodeType(node);
    if (t === "LinkText") {
      if (!alt) alt = dataOf(node);
      return;
    }
    if (t === "LinkDest") {
      if (!dest) dest = dataOf(node);
      return;
    }
    for (const ch of childrenOf(node)) walk(ch);
  };
  walk(n);
  if (!dest) {
    const fromHtml = htmlImgsToMarkdown(dataOf(n));
    if (fromHtml) return fromHtml;
  }
  if (!dest) return "";
  return `![${alt || "image"}](${dest})`;
}

function inlineText(n: SyNode, links: NormalizedLink[], keepBlockRefs: boolean): string {
  const t = nodeType(n);
  if (isBlockRef(n)) {
    const id = blockRefId(n);
    if (id) {
      const raw = `((${id}))`;
      links.push({ kind: "ref", raw, to_source_id: id, from_source_block_id: undefined });
      if (!keepBlockRefs) {
        const alias = String(n.TextMarkTextContent ?? "").trim();
        return alias || raw;
      }
      return raw;
    }
  }
  if (t === "Text") return dataOf(n);
  if (t === "TextMark") {
    const mark = String(n.TextMarkType ?? "");
    const content =
      (typeof n.TextMarkTextContent === "string" && n.TextMarkTextContent) ||
      (typeof n.TextMarkInlineMathContent === "string" && n.TextMarkInlineMathContent) ||
      dataOf(n);
    if (mark.split(/\s+/).includes("a")) {
      const href = String(n.TextMarkAHref ?? "");
      if (href) {
        if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
          links.push({ kind: "url", raw: `[${content}](${href})` });
        }
        return `[${content}](${href})`;
      }
    }
    if (mark.split(/\s+/).includes("code")) return `\`${content}\``;
    if (mark.split(/\s+/).includes("strong")) return `**${content}**`;
    if (mark.split(/\s+/).includes("em")) return `*${content}*`;
    return content;
  }
  if (t === "CodeBlockCode" || t === "MathBlockContent" || t === "LinkText" || t === "LinkDest") {
    return dataOf(n);
  }
  if (t === "Image") return imageNodeToMarkdown(n);
  if (t === "HTMLBlock" || t === "HTML" || t === "InlineHTML" || t === "InlineHtml") {
    const md = htmlImgsToMarkdown(dataOf(n));
    if (md) return md;
  }
  if (t === "SoftBreak" || t === "Br") return "\n";
  return childrenOf(n).map((c) => inlineText(c, links, keepBlockRefs)).join("");
}

function blockTypeOf(t: string): BlockType | null {
  switch (t) {
    case "Heading":
      return "heading";
    case "Paragraph":
      return "para";
    case "List":
    case "ListItem":
      return "list";
    case "CodeBlock":
      return "code";
    case "Blockquote":
      return "quote";
    case "Table":
      return "table";
    default:
      return null;
  }
}

function headingLevel(n: SyNode): number {
  const lv = n.HeadingLevel ?? n.headingLevel;
  const nlv = typeof lv === "number" ? lv : Number(lv);
  if (nlv >= 1 && nlv <= 6) return nlv;
  return 1;
}

function renderBlock(
  n: SyNode,
  links: NormalizedLink[],
  blocks: NormalizedBlock[],
  keepBlockRefs: boolean,
  depth: number,
): string {
  const t = nodeType(n);
  const kids = childrenOf(n);

  if (t === "Document") {
    return kids.map((c) => renderBlock(c, links, blocks, keepBlockRefs, depth)).filter(Boolean).join("\n\n");
  }

  if (t === "Heading") {
    const text = kids.map((c) => inlineText(c, links, keepBlockRefs)).join("").trim();
    const md = `${"#".repeat(headingLevel(n))} ${text}`;
    const id = nodeId(n) || `heading-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "heading",
      text,
      markdown: md,
      order_key: orderKey(blocks.length),
      depth: headingLevel(n),
    });
    return md;
  }

  if (t === "Paragraph") {
    const text = kids.map((c) => inlineText(c, links, keepBlockRefs)).join("");
    const md = text;
    const id = nodeId(n) || `para-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "para",
      text: text.replace(/\s+/g, " ").trim(),
      markdown: md,
      order_key: orderKey(blocks.length),
      depth,
    });
    return md;
  }

  if (t === "List") {
    const items = kids.filter((c) => nodeType(c) === "ListItem");
    const listData = (n.ListData ?? {}) as { Typ?: number };
    const ordered = listData.Typ === 1;
    const lines: string[] = [];
    let i = 1;
    for (const item of items) {
      const inner = childrenOf(item)
        .map((c) => renderBlock(c, links, blocks, keepBlockRefs, depth + 1))
        .join("\n")
        .trim();
      const bullet = ordered ? `${i}. ` : "- ";
      lines.push(bullet + inner.replace(/\n/g, "\n  "));
      i++;
    }
    const md = lines.join("\n");
    const id = nodeId(n) || `list-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "list",
      text: md.replace(/^[-*\d.]\s+/gm, "").replace(/\s+/g, " ").trim(),
      markdown: md,
      order_key: orderKey(blocks.length),
      depth,
    });
    return md;
  }

  if (t === "ListItem") {
    return kids.map((c) => renderBlock(c, links, blocks, keepBlockRefs, depth)).join("\n");
  }

  if (t === "CodeBlock") {
    let info = "";
    if (typeof n.CodeBlockInfo === "string" && n.CodeBlockInfo) {
      try {
        info = Buffer.from(n.CodeBlockInfo, "base64").toString("utf8");
      } catch {
        info = n.CodeBlockInfo;
      }
    }
    const code = kids
      .filter((c) => nodeType(c) === "CodeBlockCode")
      .map((c) => dataOf(c))
      .join("");
    const md = "```" + info + "\n" + code.replace(/\n+$/, "") + "\n```";
    const id = nodeId(n) || `code-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "code",
      text: code,
      markdown: md,
      order_key: orderKey(blocks.length),
      depth,
    });
    return md;
  }

  if (t === "Blockquote") {
    const inner = kids
      .filter((c) => nodeType(c) !== "BlockquoteMarker")
      .map((c) => renderBlock(c, links, blocks, keepBlockRefs, depth + 1))
      .join("\n");
    const md = inner
      .split("\n")
      .map((ln) => (ln ? `> ${ln}` : ">"))
      .join("\n");
    const id = nodeId(n) || `quote-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "quote",
      text: inner.replace(/\s+/g, " ").trim(),
      markdown: md,
      order_key: orderKey(blocks.length),
      depth,
    });
    return md;
  }

  if (t === "Table") {
    const rows: string[][] = [];
    const walkRow = (row: SyNode) => {
      const cells = childrenOf(row).filter((c) => nodeType(c) === "TableCell" || nodeType(c) === "TableRow");
      if (nodeType(row) === "TableRow" || nodeType(row) === "TableHead") {
        const tds = childrenOf(row).filter((c) => nodeType(c) === "TableCell");
        if (tds.length) {
          rows.push(tds.map((c) => childrenOf(c).map((x) => inlineText(x, links, keepBlockRefs)).join("").trim()));
        } else {
          for (const ch of childrenOf(row)) walkRow(ch);
        }
      } else {
        for (const ch of cells) walkRow(ch);
      }
    };
    for (const ch of kids) walkRow(ch);
    if (!rows.length) return "";
    const head = rows[0];
    const sep = head.map(() => "---");
    const mdLines = [
      `| ${head.join(" | ")} |`,
      `| ${sep.join(" | ")} |`,
      ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`),
    ];
    const md = mdLines.join("\n");
    const id = nodeId(n) || `table-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: "table",
      text: rows.flat().join(" "),
      markdown: md,
      order_key: orderKey(blocks.length),
      depth,
    });
    return md;
  }

  if (t === "HTMLBlock" || t === "HTML") {
    const html = dataOf(n) || kids.map((c) => dataOf(c)).join("");
    const md = htmlImgsToMarkdown(html);
    if (md) {
      const id = nodeId(n) || `html-${blocks.length}`;
      blocks.push({
        source_block_id: id,
        type: "para",
        text: md.replace(/\s+/g, " ").trim(),
        markdown: md,
        order_key: orderKey(blocks.length),
        depth,
      });
      return md;
    }
  }

  // unknown container: walk children
  const bt = blockTypeOf(t);
  if (bt) {
    const text = kids.map((c) => inlineText(c, links, keepBlockRefs)).join("");
    const id = nodeId(n) || `${bt}-${blocks.length}`;
    blocks.push({
      source_block_id: id,
      type: bt,
      text: text.replace(/\s+/g, " ").trim(),
      markdown: text,
      order_key: orderKey(blocks.length),
      depth,
    });
    return text;
  }
  return kids.map((c) => renderBlock(c, links, blocks, keepBlockRefs, depth)).filter(Boolean).join("\n\n");
}

export function syToMarkdown(
  sy: unknown,
  opts?: { keepBlockRefs?: boolean },
): { markdown: string; blocks: NormalizedBlock[]; links: NormalizedLink[] } {
  const keepBlockRefs = opts?.keepBlockRefs !== false;
  const root = asNode(sy);
  const blocks: NormalizedBlock[] = [];
  const links: NormalizedLink[] = [];
  if (!root) return { markdown: "\n", blocks, links };
  const md = renderBlock(root, links, blocks, keepBlockRefs, 0);
  const markdown = canonicalizeBody(md);
  return { markdown, blocks, links };
}

function markdownFallback(raw: string): { markdown: string; blocks: NormalizedBlock[]; links: NormalizedLink[] } {
  const links: NormalizedLink[] = [];
  const re = /\(\(([0-9]{14}-[0-9a-z]+)\)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    links.push({ kind: "ref", raw: m[0], to_source_id: m[1] });
  }
  const markdown = canonicalizeBody(raw);
  const blocks: NormalizedBlock[] = [];
  const parts = markdown.split(/\n{2,}/);
  let i = 0;
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const hm = /^(#{1,6})\s+(.*)$/.exec(t.split("\n")[0]);
    if (hm) {
      blocks.push({
        source_block_id: `md-heading-${i}`,
        type: "heading",
        text: hm[2],
        markdown: t,
        order_key: orderKey(i),
        depth: hm[1].length,
      });
    } else {
      blocks.push({
        source_block_id: `md-para-${i}`,
        type: "para",
        text: t.replace(/\s+/g, " ").trim(),
        markdown: t,
        order_key: orderKey(i),
        depth: 0,
      });
    }
    i++;
  }
  return { markdown, blocks, links };
}

export function normalizeSiyuanNote(
  payload: NotePayload,
  _connectionId: string,
  extraAssets: NormalizedAsset[] = [],
): NormalizedNote {
  const raw = typeof payload.raw === "string" ? payload.raw : new TextDecoder().decode(payload.raw);
  const trimmed = raw.trim();
  let converted: { markdown: string; blocks: NormalizedBlock[]; links: NormalizedLink[] };
  let frontmatter: Record<string, unknown> = {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as SyNode;
      const p = propsOf(parsed);
      converted = syToMarkdown(parsed);
      frontmatter = { ...p };
      if (typeof p.title === "string") frontmatter.title = p.title;
    } catch {
      converted = markdownFallback(raw);
    }
  } else {
    converted = markdownFallback(raw);
  }
  const title =
    (typeof frontmatter.title === "string" && frontmatter.title) ||
    payload.title ||
    titleFromPath(payload.path);
  return {
    source_id: payload.source_id,
    path: payload.path,
    title,
    markdown: converted.markdown,
    frontmatter,
    hash: sha256Hex(converted.markdown),
    blocks: converted.blocks,
    links: converted.links,
    assets: extraAssets,
  };
}
