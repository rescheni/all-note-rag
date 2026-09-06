import { isAssetTarget, parseMarkdownLinks, parseWikiLinks } from "./wiki.ts";
import type { SourceKind } from "./types.ts";

export type NoteLinkCandidate = {
  raw: string;
  rawTarget: string;
  label: string;
  kind: "wiki" | "block_ref" | "page_mention" | "doc_mention" | "note_path";
  index: number;
  heading?: string;
  nativeId?: string;
  path?: string;
  title?: string;
};
export function normalizeNativeId(value: string): string { return value.replace(/-/g, "").toLowerCase(); }
function notionId(href: string): string | undefined {
  if (!/^https?:\/\/(?:www\.)?notion\.so\//i.test(href)) return;
  const ids = href.match(/[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi);
  return ids?.length ? normalizeNativeId(ids[ids.length - 1]) : undefined;
}
function feishuToken(href: string): string | undefined {
  return href.match(/^https?:\/\/[^/]*feishu\.cn\/(?:wiki|docs|docx)\/([A-Za-z0-9_-]+)/i)?.[1];
}
/** Source-native potentially navigable links only; ordinary web URLs and assets are excluded. */
export function extractNoteLinkCandidates(markdown: string, source: SourceKind): NoteLinkCandidate[] {
  const out: NoteLinkCandidate[] = [], seen = new Set<string>();
  const add = (x: NoteLinkCandidate) => { const key = `${x.index}\0${x.raw}\0${x.rawTarget}`; if (!seen.has(key)) { seen.add(key); out.push(x); } };
  if (source === "obsidian") for (const x of parseWikiLinks(markdown)) {
    if (!x.embed && !isAssetTarget(x.target)) add({ raw: x.raw, rawTarget: x.target, label: x.alias || x.target.split("/").pop() || x.target, kind: "wiki", index: x.index, heading: x.heading, path: x.target, title: x.target.split("/").pop() });
  }
  if (source === "siyuan") {
    const re = /\(\(([0-9]{14}-[a-z0-9]{7})(?:\s+["']([^"']+)["'])?\)\)/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(markdown))) add({ raw: m[0], rawTarget: m[1], label: m[2] || "引用块", kind: "block_ref", index: m.index, nativeId: m[1] });
  }
  for (const x of parseMarkdownLinks(markdown)) {
    if (x.embed || isAssetTarget(x.href)) continue;
    const ni = source === "notion" ? notionId(x.href) : undefined;
    const ft = source === "feishu" ? feishuToken(x.href) : undefined;
    const su = source === "siyuan" ? x.href.match(/^siyuan:\/\/blocks\/([0-9]{14}-[a-z0-9]{7})/i)?.[1] : undefined;
    const sp = source === "siyuan" ? x.href.split(/[?#]/)[0].match(/(?:^|\/)([0-9]{14}-[a-z0-9]{7})\.sy$/i)?.[1] : undefined;
    if (ni) add({ raw: x.raw, rawTarget: x.href, label: x.text || "页面", kind: "page_mention", index: x.index, nativeId: ni });
    else if (ft) add({ raw: x.raw, rawTarget: x.href, label: x.text || "文档", kind: "doc_mention", index: x.index, nativeId: ft });
    else if (su || sp) add({ raw: x.raw, rawTarget: x.href, label: x.text || "引用块", kind: su ? "block_ref" : "note_path", index: x.index, nativeId: su || sp });
    else if (source === "obsidian" && !/^[a-z][a-z0-9+.-]*:/i.test(x.href)) { const t = decodeURIComponent(x.href.split("#")[0].split("?")[0]); if (t) add({ raw: x.raw, rawTarget: t, label: x.text || t, kind: "note_path", index: x.index, path: t, title: t.split("/").pop()?.replace(/\.md$/i, "") }); }
  }
  const covered = (index: number) => out.some((x) => index >= x.index && index < x.index + x.raw.length);
  if (source === "notion") {
    const re = /https?:\/\/(?:www\.)?notion\.so\/[^\s<>)]+/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(markdown))) {
      const id = notionId(m[0]);
      if (id && !covered(m.index)) add({ raw: m[0], rawTarget: m[0], label: "Notion 页面", kind: "page_mention", index: m.index, nativeId: id });
    }
  }
  if (source === "feishu") {
    const re = /https?:\/\/[^/\s]*feishu\.cn\/(?:wiki|docs|docx)\/[A-Za-z0-9_-]+[^\s<>) ]*/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(markdown))) {
      const id = feishuToken(m[0]);
      if (id && !covered(m.index)) add({ raw: m[0], rawTarget: m[0], label: "飞书文档", kind: "doc_mention", index: m.index, nativeId: id });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
