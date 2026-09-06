import MarkdownIt from "markdown-it";
import { mediaKindOf, type NormalizedBlock, type NormalizedNote } from "@note-hub/core";

/** Bump when preview chrome CSS changes so GET /preview re-renders stale S3 objects. */
export const PREVIEW_STYLE_ID = "healing-paper-v8-ink";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  tokens[idx].attrSet("target", "_top");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  if (href.startsWith("/notes/")) tokens[idx].attrSet("class", "note-link");
  if (href === "#dangling") {
    tokens[idx].attrSet("class", "note-link dangling");
    tokens[idx].attrSet("aria-label", "尚未同步的笔记");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export type PreviewNoteLink = { raw: string; label: string; targetNoteId: string | null; heading?: string };
export type PreviewBacklink = { noteId: string; title: string; path: string };

/** Longest raw first so nested/overlapping wiki tokens rewrite cleanly. */
export function rewriteKnownNoteLinks(src: string, links: PreviewNoteLink[]): string {
  let body = src;
  const ordered = [...links].sort((a, b) => b.raw.length - a.raw.length);
  for (const link of ordered) {
    if (!body.includes(link.raw)) continue;
    const href = link.targetNoteId
      ? `/notes/${link.targetNoteId}${link.heading ? `#b-${link.heading}` : ""}`
      : "#dangling";
    const title = link.targetNoteId ? "在笔记中枢打开" : "尚未同步的笔记";
    const label = link.label.replace(/([\\\[\]()])/g, "\\$1");
    body = body.split(link.raw).join(`[${label}](${href} "${title}")`);
  }
  return body;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

const ALLOWED_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "blockquote",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "br",
  "strong",
  "em",
  // HTML5 media players for audio/video assets. Attributes are allowlisted below:
  // no event handlers, no autoplay, no srcdoc.
  "audio",
  "video",
  "source",
]);
const VOID_TAGS = new Set(["br", "img", "source"]);
const ALLOWED_ATTR: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "class", "aria-label"]),
  img: new Set(["src", "alt", "title"]),
  audio: new Set(["src", "controls", "type"]),
  video: new Set(["src", "controls", "type", "poster"]),
  source: new Set(["src", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};
/** URL-bearing attributes that get the assetBase prefix. */
const MEDIA_SRC_TAGS = "img|video|audio|source";

function isSafeUrl(raw: string, kind: "href" | "src"): boolean {
  const v = raw.trim();
  if (!v) return false;
  const lower = v.toLowerCase().replace(/[\u0000-\u0020]/g, "");
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return false;
  if (lower.startsWith("data:text") || lower.startsWith("data:application")) return false;
  if (kind === "src" && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(lower)) return true;
  if (/^(https?:|\/|#|\.\/)/i.test(v)) return true;
  if (kind === "href" && lower.startsWith("mailto:")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;
  return false;
}

function parseAllowedAttrs(raw: string, tag: string): string {
  const allowed = ALLOWED_ATTR[tag];
  if (!allowed) return "";
  const parts: string[] = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (name.startsWith("on") || name === "style" || name.startsWith("xmlns") || name === "srcset") continue;
    if (!allowed.has(name)) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (name === "controls") {
      // Boolean attribute; never echo an attacker-supplied value back.
      parts.push(" controls");
      continue;
    }
    if ((name === "href" || name === "src" || name === "poster") && !isSafeUrl(val, name === "href" ? "href" : "src")) {
      continue;
    }
    if ((name === "colspan" || name === "rowspan") && !/^\d{1,3}$/.test(val)) continue;
    parts.push(` ${name}="${escapeAttr(val)}"`);
  }
  if (tag === "a") parts.push(' rel="noopener noreferrer"');
  return parts.join("");
}

/** XSS-safe allowlist. Unknown tags are dropped; their text is kept. */
export function sanitizeHtmlFragment(input: string): string {
  let s = input.replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|form|textarea|noscript|svg|math)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|form|input|button|svg|math)\b[^>]*\/?>/gi, "");
  const out: string[] = [];
  const openStack: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push(escapeText(s.slice(last, m.index)));
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith("</");
    const selfClosing = /\/\s*>$/.test(m[0]) || VOID_TAGS.has(tag);
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      const idx = openStack.lastIndexOf(tag);
      if (idx < 0) continue;
      while (openStack.length > idx) {
        const t = openStack.pop()!;
        out.push(`</${t}>`);
      }
      continue;
    }
    const attrs = parseAllowedAttrs(m[2], tag);
    if (VOID_TAGS.has(tag) || selfClosing) {
      out.push(`<${tag}${attrs}>`);
    } else {
      openStack.push(tag);
      out.push(`<${tag}${attrs}>`);
    }
  }
  out.push(escapeText(s.slice(last)));
  while (openStack.length) out.push(`</${openStack.pop()}>`);
  return out.join("").trim();
}

/** True when a block is an HTML document/fragment rather than markdown with an incidental tag. */
export function looksLikeHtmlFragment(src: string): boolean {
  const t = src.trim();
  if (!t || t.startsWith("```")) return false;
  if (
    /^<(?:!DOCTYPE|html|head|body|div|p|h[1-6]|ul|ol|table|section|article|blockquote|pre|span|audio|video)\b/i.test(t)
  ) {
    return true;
  }
  const tags = t.match(/<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g);
  if (!tags || tags.length < 2) return false;
  return tags.join("").length / t.length >= 0.12;
}

export function renderBlockHtml(block: NormalizedBlock, links: PreviewNoteLink[] = []): string {
  const safeLinks = Array.isArray(links) ? links : [];
  const src = rewriteWiki(rewriteKnownNoteLinks(block.markdown, safeLinks));
  let inner: string;
  if (block.type === "code") {
    inner = md.render(src);
  } else if (looksLikeHtmlFragment(src)) {
    inner = sanitizeHtmlFragment(src);
    if (!inner) inner = md.render(src);
  } else {
    inner = md.render(src);
  }
  return `<section class="nh-block" id="b-${escapeAttr(block.source_block_id)}" data-block-type="${block.type}">${inner}</section>`;
}

function renderBacklinksHtml(backlinks: PreviewBacklink[]): string {
  if (!backlinks.length) {
    return `<aside class="nh-backlinks" aria-label="反向链接">
<h2>反向链接</h2>
<p class="nh-backlinks-empty">暂无其他笔记链到这里</p>
</aside>`;
  }
  const items = backlinks
    .map(
      (b) =>
        `<li><a class="note-link" target="_top" rel="noopener noreferrer" href="/notes/${escapeAttr(b.noteId)}" title="在笔记中枢打开">${escapeText(b.title || b.path)}</a><span class="nh-backlink-path">${escapeText(b.path)}</span></li>`,
    )
    .join("\n");
  return `<aside class="nh-backlinks" aria-label="反向链接">
<h2>反向链接</h2>
<ul>
${items}
</ul>
</aside>`;
}

/** Turn leftover jammed SiYuan text like `imageassets/foo.png` into <img>. */
export function rewriteJammedSiyuanImages(html: string, assetBase: string): string {
  const base = assetBase || "";
  return html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag: string | undefined, text: string | undefined) => {
    if (tag) return tag;
    if (!text || !/assets\//i.test(text)) return text ?? all;
    return text.replace(
      /(\S*?)(assets\/[^\s<>"'()]+\.(?:png|jpe?g|gif|webp|svg|pdf))/gi,
      (_m, prefix: string, path: string) => {
        const alt = !prefix || prefix === "image" || prefix === "!" ? "image" : prefix.replace(/!$/, "") || "image";
        return `<img src="${base}${path}" alt="${escapeAttr(alt)}">`;
      },
    );
  });
}

/** Turn <a href="…mp3|mp4…"> into an HTML5 player so attachments actually play. */
export function promoteMediaAnchors(html: string): string {
  return html.replace(
    /<a\b([^>]*?)\shref="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
    (all, pre: string, href: string, post: string, label: string) => {
      if (/\bnote-link\b/i.test(`${pre} ${post}`)) return all;
      const pathOnly = (href.split(/[?#]/)[0] || "").trim();
      let probe = pathOnly;
      try {
        const u = new URL(href, "http://local.invalid");
        const q = u.searchParams.get("path");
        if (q) probe = q;
        else if (u.pathname && u.pathname !== "/") probe = u.pathname;
      } catch {
        /* keep */
      }
      const plain = (label || "").replace(/<[^>]+>/g, "").trim();
      const kind = mediaKindOf(probe) || mediaKindOf(pathOnly) || mediaKindOf(plain);
      if (!kind) return all;
      const safeLabel = escapeText(plain || probe.split("/").pop() || "媒体");
      const safeHref = escapeAttr(href);
      if (kind === "audio") {
        return `<div class="nh-media nh-audio"><audio controls preload="metadata" src="${safeHref}"></audio><div class="nh-media-cap">${safeLabel}</div></div>`;
      }
      return `<div class="nh-media nh-video"><video controls preload="metadata" src="${safeHref}"></video><div class="nh-media-cap">${safeLabel}</div></div>`;
    },
  );
}

/** Rewrite relative img/href/url(...) to assetBase. Skips http(s), data:, and root-absolute paths. */
export function rewritePreviewAssetUrls(html: string, assetBase: string): string {
  const base = assetBase || "";
  let body = rewriteJammedSiyuanImages(html, base);
  if (base) {
    body = body.replace(
      new RegExp(`(<(?:${MEDIA_SRC_TAGS})\\b[^>]*\\ssrc=")(?!https?:|data:|/)([^"]+)(")`, "gi"),
      (_a, pre: string, src: string, post: string) => `${pre}${base}${src.replace(/^\.\//, "")}${post}`,
    );
    body = body.replace(
      /(<video\b[^>]*\sposter=")(?!https?:|data:|\/)([^"]+)(")/gi,
      (_a, pre: string, src: string, post: string) => `${pre}${base}${src.replace(/^\.\//, "")}${post}`,
    );
    body = body.replace(
      /(<a\b[^>]*\shref=")(?!https?:|data:|\/|#)([^"]+)(")/gi,
      (_a, pre: string, src: string, post: string) => `${pre}${base}${src.replace(/^\.\//, "")}${post}`,
    );
    body = body.replace(
      /(url\()(['"]?)(?!https?:|data:|\/|#)([^'")]+)(\2\))/gi,
      (_a, pre: string, q: string, src: string, post: string) =>
        `${pre}${q}${base}${src.replace(/^\.\//, "")}${post}`,
    );
  }
  return promoteMediaAnchors(body);
}

export function isCurrentPreviewHtml(html: string): boolean {
  return html.includes(`data-preview-style="${PREVIEW_STYLE_ID}"`);
}

const PREVIEW_CSS = `
  html, body {
    margin: 0;
    background: #fffaf2;
    color: #3c332c;
  }
  html { scrollbar-gutter: stable; }
  body {
    font-family: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 1rem;
    line-height: 1.72;
    max-width: 68ch;
    margin: 0 auto;
    padding: 1.65rem 1.5rem 3.25rem;
  }
  article { min-height: 40vh; }
  section.nh-block {
    scroll-margin-top: 5rem;
    margin: 0.05rem 0;
    padding: 0.35rem 0.15rem;
    border-radius: 8px;
    border: 1px solid transparent;
    transition: background 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }
  section.nh-block:hover {
    background: rgba(243, 238, 228, 0.55);
  }
  section.nh-block:target,
  section.nh-block.is-jump-target {
    background: rgba(94, 138, 104, 0.14);
    border-color: rgba(94, 138, 104, 0.35);
    box-shadow: 0 0 0 3px rgba(94, 138, 104, 0.12);
  }
  section.nh-block > :first-child { margin-top: 0; }
  section.nh-block > :last-child { margin-bottom: 0; }
  section.nh-block[data-block-type="heading"] {
    padding-top: 0.95rem;
    padding-bottom: 0.2rem;
  }
  section.nh-block[data-block-type="heading"]:hover {
    background: transparent;
  }
  h1, h2, h3 {
    font-family: "Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif;
    font-weight: 600;
    color: #3c332c;
    line-height: 1.35;
    letter-spacing: 0.01em;
    text-wrap: balance;
  }
  h1 { font-size: 1.55rem; margin: 0 0 0.6rem; }
  h2 { font-size: 1.22rem; margin: 0.4rem 0 0.4rem; }
  h3 { font-size: 1.05rem; margin: 0.3rem 0 0.3rem; }
  p { margin: 0.55rem 0; }
  a { color: #5e8a68; text-underline-offset: 0.18em; }
  a:hover { color: #4e7a58; }
  a.note-link {
    color: #5e8a68;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-decoration-color: rgba(94, 138, 104, 0.4);
    border-radius: 4px;
    padding: 0 0.1em;
  }
  a.note-link:hover {
    background: rgba(94, 138, 104, 0.1);
    text-decoration-color: #5e8a68;
  }
  a.note-link.dangling,
  a.dangling {
    color: #8a7d70;
    text-decoration-style: dashed;
    text-decoration-color: #cbbfae;
    cursor: help;
  }
  a.note-link.dangling:hover {
    background: rgba(203, 191, 174, 0.28);
  }
  img { max-width: 100%; height: auto; border-radius: 12px; }
  audio, video { max-width: 100%; border-radius: 12px; }
  audio { width: 100%; }
  .nh-media { margin: 0.75rem 0 1rem; }
  .nh-media-cap { margin-top: 0.35rem; font-size: 0.8rem; color: #8a7d70; }
  video { height: auto; background: #3c332c; }
  pre {
    background: #f3eee4;
    border: 1px solid #e4d9c8;
    border-radius: 12px;
    padding: 0.85rem 1rem;
    overflow: auto;
    margin: 0.45rem 0;
    line-height: 1.5;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8125rem;
  }
  :not(pre) > code {
    background: #f3eee4;
    border: 1px solid #e4d9c8;
    border-radius: 6px;
    padding: 0.08em 0.35em;
  }
  blockquote {
    border-left: 3px solid #5e8a68;
    margin: 0.65rem 0;
    padding: 0.4rem 0.85rem;
    color: #6e6258;
    background: rgba(94, 138, 104, 0.06);
    border-radius: 0 10px 10px 0;
  }
  table { border-collapse: collapse; width: 100%; margin: 0.85rem 0; font-size: 0.9rem; }
  th, td { border: 1px solid #e4d9c8; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #f3eee4; font-weight: 600; }
  ul, ol { padding-left: 1.35rem; margin: 0.45rem 0; }
  li { margin: 0.15rem 0; }
  .nh-backlinks {
    margin-top: 2.5rem;
    padding-top: 1.1rem;
    border-top: 1px solid #e4d9c8;
    max-width: 68ch;
  }
  .nh-backlinks h2 {
    font-family: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.06em;
    margin: 0 0 0.65rem;
    color: #8a7d70;
  }
  .nh-backlinks ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .nh-backlinks li {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    padding: 0.45rem 0.5rem;
    border-radius: 10px;
    margin: 0.12rem 0;
  }
  .nh-backlinks li:hover {
    background: rgba(243, 238, 228, 0.85);
  }
  .nh-backlink-path {
    font-size: 0.7rem;
    color: #8a7d70;
  }
  .nh-backlinks-empty {
    color: #8a7d70;
    font-size: 0.8125rem;
    margin: 0;
  }
  ::selection { background: #5e8a68; color: #fffaf2; }
  * { scrollbar-width: thin; scrollbar-color: #cbbfae #fffaf2; }

  /* 墨夜：跟壳层 ink 对齐，暖墨底 + 淡纸字 */
  html[data-theme="ink"],
  html[data-theme="ink"] body {
    background: #1c1916;
    color: #e8e0d4;
  }
  html[data-theme="ink"] section.nh-block:hover {
    background: rgba(42, 37, 33, 0.85);
  }
  html[data-theme="ink"] section.nh-block:target,
  html[data-theme="ink"] section.nh-block.is-jump-target {
    background: rgba(127, 168, 138, 0.16);
    border-color: rgba(127, 168, 138, 0.4);
    box-shadow: 0 0 0 3px rgba(127, 168, 138, 0.12);
  }
  html[data-theme="ink"] h1,
  html[data-theme="ink"] h2,
  html[data-theme="ink"] h3 {
    color: #e8e0d4;
  }
  html[data-theme="ink"] a,
  html[data-theme="ink"] a.note-link {
    color: #7fa88a;
    text-decoration-color: rgba(127, 168, 138, 0.45);
  }
  html[data-theme="ink"] a:hover,
  html[data-theme="ink"] a.note-link:hover {
    color: #91b89a;
    background: rgba(127, 168, 138, 0.12);
    text-decoration-color: #7fa88a;
  }
  html[data-theme="ink"] a.note-link.dangling,
  html[data-theme="ink"] a.dangling {
    color: #a39688;
    text-decoration-color: #5a5046;
  }
  html[data-theme="ink"] a.note-link.dangling:hover {
    background: rgba(90, 80, 70, 0.35);
  }
  html[data-theme="ink"] pre {
    background: #241f1b;
    border-color: #3a322c;
  }
  html[data-theme="ink"] :not(pre) > code {
    background: #241f1b;
    border-color: #3a322c;
  }
  html[data-theme="ink"] blockquote {
    border-left-color: #7fa88a;
    color: #a39688;
    background: rgba(127, 168, 138, 0.08);
  }
  html[data-theme="ink"] th,
  html[data-theme="ink"] td {
    border-color: #3a322c;
  }
  html[data-theme="ink"] th {
    background: #241f1b;
  }
  html[data-theme="ink"] .nh-backlinks {
    border-top-color: #3a322c;
  }
  html[data-theme="ink"] .nh-backlinks h2,
  html[data-theme="ink"] .nh-backlink-path,
  html[data-theme="ink"] .nh-backlinks-empty,
  html[data-theme="ink"] .nh-media-cap {
    color: #a39688;
  }
  html[data-theme="ink"] .nh-backlinks li:hover {
    background: rgba(42, 37, 33, 0.9);
  }
  html[data-theme="ink"] video {
    background: #0f0d0b;
  }
  html[data-theme="ink"] ::selection {
    background: #7fa88a;
    color: #1c1916;
  }
  html[data-theme="ink"] * {
    scrollbar-color: #5a5046 #1c1916;
  }
  /* 素白：略冷一点的浅色纸 */
  html[data-theme="plain"],
  html[data-theme="plain"] body {
    background: #ffffff;
    color: #2f2c28;
  }
  html[data-theme="plain"] h1,
  html[data-theme="plain"] h2,
  html[data-theme="plain"] h3 {
    color: #2f2c28;
  }
  html[data-theme="plain"] a,
  html[data-theme="plain"] a.note-link {
    color: #4f7a5a;
  }
  html[data-theme="plain"] pre,
  html[data-theme="plain"] :not(pre) > code {
    background: #f6f5f2;
    border-color: #e2e0d8;
  }
  html[data-theme="plain"] th,
  html[data-theme="plain"] td {
    border-color: #e2e0d8;
  }
  html[data-theme="plain"] th {
    background: #f6f5f2;
  }
  @media (prefers-reduced-motion: reduce) {
    section.nh-block { transition: none; }
  }
`.trim();

export function renderPreviewHtml(
  note: Pick<NormalizedNote, "title" | "blocks" | "hash" | "path">,
  opts?: { assetBase?: string; links?: PreviewNoteLink[]; backlinks?: PreviewBacklink[] },
): string {
  const links = opts?.links ?? [];
  const backlinks = opts?.backlinks ?? [];
  const sections = note.blocks.map((block) => renderBlockHtml(block, links)).join("\n");
  const body = opts?.assetBase ? rewritePreviewAssetUrls(sections, opts.assetBase) : sections;
  const backlinksHtml = renderBacklinksHtml(backlinks);
  return `<!DOCTYPE html>
<html lang="zh-CN" data-preview-style="${PREVIEW_STYLE_ID}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeAttr(note.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600&family=Noto+Serif+SC:wght@600&display=swap" rel="stylesheet"/>
<style>
${PREVIEW_CSS}
</style>
</head>
<body>
<article data-hash="${escapeAttr(note.hash)}" data-path="${escapeAttr(note.path)}">
${body}
${backlinksHtml}
</article>
</body>
</html>
`;
}
