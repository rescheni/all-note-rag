export type WikiMatch = {
  raw: string;
  embed: boolean;
  target: string;
  heading?: string;
  alias?: string;
  index: number;
};

const WIKI_RE = /(!)?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /(!)?\[([^\]]*)\]\(([^)]+)\)/g;

export function parseWikiLinks(markdown: string): WikiMatch[] {
  const out: WikiMatch[] = [];
  const re = new RegExp(WIKI_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    out.push({
      raw: m[0],
      embed: m[1] === "!",
      target: m[2].trim(),
      heading: m[3]?.trim(),
      alias: m[4]?.trim(),
      index: m.index,
    });
  }
  return out;
}

export type MdLinkMatch = {
  raw: string;
  embed: boolean;
  text: string;
  href: string;
  index: number;
};

export function parseMarkdownLinks(markdown: string): MdLinkMatch[] {
  const out: MdLinkMatch[] = [];
  const re = new RegExp(MD_LINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    out.push({
      raw: m[0],
      embed: m[1] === "!",
      text: m[2],
      href: m[3].trim(),
      index: m.index,
    });
  }
  return out;
}

export function isAssetTarget(target: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|webm|docx?)$/i.test(target);
}

/** Resolve wiki target relative to note path: same-dir, then as vault path. */
export function resolveWikiTarget(notePath: string, target: string): string {
  const t = target.replace(/\\/g, "/").replace(/\.md$/i, "");
  if (t.startsWith("/")) return t.replace(/^\/+/, "") + (isAssetTarget(target) ? "" : "");
  const dir = notePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  if (t.includes("/")) {
    return t + (isAssetTarget(target) || target.endsWith(".md") ? "" : "");
  }
  const sameDir = dir ? `${dir}/${t}` : t;
  return sameDir;
}


/** Paths like assets/foo.png mentioned in markdown or source JSON. */
export function collectAssetRefs(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|["'(\s=])((?:\.\.\/)*(?:\.\.\/)?(?:\.\/)?assets\/[^\s"'\\<>)\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let p = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    p = p.replace(/^\/+/, "");
    const cut = p.split(/[?#]/)[0];
    if (cut) out.add(cut);
  }
  return [...out];
}

export function guessContentType(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}
