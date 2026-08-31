import MarkdownIt from "markdown-it";
import type { NormalizedBlock, NormalizedNote } from "@note-hub/core";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function rewriteWiki(src: string): string {
  return src.replace(
    /(!)?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (_all, embed: string | undefined, target: string, heading: string | undefined, alias: string | undefined) => {
      const label = alias || target.split("/").pop() || target;
      if (embed) {
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(target)) {
          return `![${label}](${target})`;
        }
        return `<span class="embed">${escapeAttr(label)}</span>`;
      }
      const href = heading ? `#b-${heading}` : `#`;
      return `[${label}](${href})`;
    },
  );
}

export function renderBlockHtml(block: NormalizedBlock): string {
  const inner = md.render(rewriteWiki(block.markdown));
  return `<section id="b-${escapeAttr(block.source_block_id)}" data-block-type="${block.type}">${inner}</section>`;
}

export function renderPreviewHtml(
  note: Pick<NormalizedNote, "title" | "blocks" | "hash" | "path">,
  opts?: { assetBase?: string },
): string {
  const sections = note.blocks.map(renderBlockHtml).join("\n");
  let body = sections;
  if (opts?.assetBase) {
    body = body.replace(
      /(<img\b[^>]*\ssrc=")(?!https?:|data:|\/)([^"]+)(")/g,
      (_a, pre: string, src: string, post: string) => `${pre}${opts.assetBase}${src.replace(/^\.\//, "")}${post}`,
    );
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeAttr(note.title)}</title>
<style>
  body { font-family: "Noto Sans SC", "Source Han Sans", "PingFang SC", sans-serif; max-width: 52rem; margin: 0 auto; padding: 1.5rem; line-height: 1.65; color: #1a1a1a; }
  section { scroll-margin-top: 4rem; }
  img { max-width: 100%; }
  pre { background: #f4f1ea; padding: 0.75rem; overflow: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote { border-left: 3px solid #c4b8a5; margin-left: 0; padding-left: 1rem; color: #444; }
  h1,h2,h3 { line-height: 1.3; }
</style>
</head>
<body>
<article data-hash="${escapeAttr(note.hash)}" data-path="${escapeAttr(note.path)}">
${body}
</article>
</body>
</html>
`;
}
