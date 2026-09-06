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
    // Audio: Notion `audio` blocks, Feishu `file` blocks (block_type 23) holding audio.
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
    case "oga":
    case "opus":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "amr":
      return "audio/amr";
    case "wma":
      return "audio/x-ms-wma";
    // Video: Notion `video` blocks, Feishu `file` blocks (block_type 23) holding video.
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
    case "qt":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    case "wmv":
    case "asf":
      return "video/x-ms-wmv";
    case "flv":
    case "f4v":
      return "video/x-flv";
    case "mpeg":
    case "mpg":
    case "mpv":
      return "video/mpeg";
    case "3gp":
      return "video/3gpp";
    default:
      return "application/octet-stream";
  }
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

/** Audio attachment by extension. */
export function isAudioPath(path: string): boolean {
  return /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|amr|wma)$/i.test(path.split(/[?#]/)[0]);
}

/** Video attachment by extension. */
export function isVideoPath(path: string): boolean {
  return /\.(mp4|m4v|webm|mov|qt|avi|mkv|wmv|asf|flv|f4v|mpeg|mpg|mpv|3gp|amv)$/i.test(
    path.split(/[?#]/)[0],
  );
}

/** Playable in an HTML5 <audio>/<video> element. */
export function isMediaPath(path: string): boolean {
  return isAudioPath(path) || isVideoPath(path);
}

/** "audio" | "video" for media attachments, else null. */
export function mediaKindOf(path: string): "audio" | "video" | null {
  if (isAudioPath(path)) return "audio";
  if (isVideoPath(path)) return "video";
  return null;
}
