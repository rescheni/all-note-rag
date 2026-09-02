export type TreeKind = "folder" | "note" | "asset";

export type TreeNode = {
  name: string;
  path: string;
  kind: TreeKind;
  note_id?: string;
  asset_id?: string;
  source?: string;
  children?: TreeNode[];
};

export type TreeInput = {
  path: string;
  kind: "note" | "asset";
  note_id?: string;
  asset_id?: string;
  source?: string;
  /** Owning note path, used to nest an asset under the note when it is not already in that folder. */
  note_path?: string;
  /** Leaf display name (note.title). Path stays the source of truth. */
  title?: string;
  connection_id?: string;
  connection_name?: string;
  /** Note source_id (or owning note's source_id for assets). Used to hide SiYuan asset-notes. */
  source_id?: string;
  note_source_id?: string;
};

export type BuildFileTreeOpts = {
  /** Map SiYuan box id (14digit-id) → notebook name from conf.json / cursor. */
  boxNames?: Record<string, string>;
  boxNamesByConnection?: Record<string, Record<string, string>>;
  /** Wrap each connection/source as a top folder (我的思源 / Obsidian / 飞书). */
  groupBySource?: boolean;
};

/** Box id without `.sy`. */
const BOX_RE = /^\d{14}-[0-9a-z]+$/i;
/** Box or document id, optional `.sy` suffix. */
const ID_SEG_RE = /^\d{14}-[0-9a-z]+(\.sy)?$/i;
const IMAGE_LEAF_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

export const SOURCE_TREE_LABEL: Record<string, string> = {
  siyuan: "思源",
  obsidian: "Obsidian",
  notion: "Notion",
  feishu: "飞书",
};

/** SiYuan workspace files ingested as notes (`asset:{box}:{path}` or `asset:assets/foo.jpeg`). */
export function isAssetNoteId(source_id?: string | null): boolean {
  return typeof source_id === "string" && source_id.startsWith("asset:");
}

/** Image file used as a note/folder leaf (path or title). */
export function isImageLeafPath(path?: string | null, title?: string | null): boolean {
  if (title && IMAGE_LEAF_RE.test(title.trim())) return true;
  if (!path) return false;
  return IMAGE_LEAF_RE.test(posixPath(path));
}

function splitPath(p: string): string[] {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((s) => s && s !== ".");
}

function posixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function stripSy(seg: string): string {
  return seg.replace(/\.sy$/i, "");
}

function invertBoxNames(boxNames?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!boxNames) return out;
  for (const [id, name] of Object.entries(boxNames)) {
    const n = name.trim();
    if (n) out[n] = id;
  }
  return out;
}

function shouldCanonSiyuan(source?: string, boxNames?: Record<string, string>): boolean {
  if (source === "siyuan") return true;
  if (!source && boxNames && Object.keys(boxNames).length) return true;
  return false;
}

/**
 * Rewrite a SiYuan path so the notebook segment is the box id.
 * `only code/foo.sy` and `20241211085005-ubtel98/foo.sy` share one prefix.
 */
function canonicalizeSiyuanPath(path: string, source?: string, boxNames?: Record<string, string>): string {
  const raw = posixPath(path);
  if (!raw || !shouldCanonSiyuan(source, boxNames)) return raw;
  const segs = splitPath(raw);
  if (!segs.length) return raw;
  let i = 0;
  if (segs[0] === "data") i = 1;
  if (i >= segs.length) return raw;
  const first = segs[i];
  if (boxNames?.[first]) return segs.join("/");
  const nameToId = invertBoxNames(boxNames);
  const mapped = nameToId[first];
  if (mapped) {
    segs[i] = mapped;
    return segs.join("/");
  }
  return raw;
}

function isAssetsDumpName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "assets" || n === "附件";
}

/** Vault-root `assets/…` (after optional SiYuan `data/`), not `{box}/assets/`. */
function isVaultRootAssetsPath(path: string, source?: string): boolean {
  const segs = splitPath(path);
  let i = 0;
  if (segs[0] === "data" && (source === "siyuan" || source === undefined || segs.length > 1)) i = 1;
  if (source === "siyuan" && segs[0] === "data") i = 1;
  return segs[i] === "assets";
}

function isRealSiyuanDocPath(path?: string | null): boolean {
  if (!path) return false;
  if (isImageLeafPath(path)) return false;
  return /\.sy$/i.test(posixPath(path));
}

function isHiddenNotePath(path: string): boolean {
  const p = posixPath(path);
  if (isImageLeafPath(p)) return true;
  if (p === "assets" || p.startsWith("assets/")) return true;
  if (p === "data/assets" || p.startsWith("data/assets/")) return true;
  return false;
}

function isHumanLabel(name: string): boolean {
  const n = name.trim();
  return Boolean(n) && !ID_SEG_RE.test(n) && n !== "笔记本" && !isImageLeafPath(n);
}

function displaySegment(
  seg: string,
  fullPath: string,
  boxNames?: Record<string, string>,
  titleByPath?: Map<string, string>,
  titleById?: Map<string, string>,
): string {
  const mapped = (boxNames?.[seg]?.trim() || boxNames?.[stripSy(seg)]?.trim()) ?? "";
  if (isHumanLabel(mapped)) return mapped;
  const titled = titleByPath?.get(fullPath)?.trim();
  if (titled && isHumanLabel(titled)) return titled;
  if (ID_SEG_RE.test(seg)) {
    const byId = titleById?.get(stripSy(seg))?.trim();
    if (byId && isHumanLabel(byId)) return byId;
    // Box id (no .sy): keep a generic notebook label, never the digits.
    if (BOX_RE.test(seg) || BOX_RE.test(stripSy(seg))) return "笔记本";
    // Document id (.sy): never show the digits; caller may flatten.
    return "";
  }
  return seg;
}

function sourceRootName(item: TreeInput): string {
  const named = item.connection_name?.trim();
  if (named) return named;
  return SOURCE_TREE_LABEL[item.source ?? ""] || item.source || "源";
}

function sourceGroupKey(item: TreeInput): string {
  return item.connection_id || item.source || "_";
}

function isNotebookSeg(seg: string, index: number, skipData: boolean): boolean {
  const first = skipData ? 1 : 0;
  return index === first && ID_SEG_RE.test(seg);
}

/** Folder walk segments. Skips a leading `data/` for SiYuan so box ids sit under the source root. */
function walkParts(
  path: string,
  source?: string,
  boxNames?: Record<string, string>,
  titleByPath?: Map<string, string>,
  titleById?: Map<string, string>,
): { name: string; path: string }[] {
  const segs = splitPath(path);
  const skipData = (source === "siyuan" || source === undefined) && segs[0] === "data";
  const out: { name: string; path: string }[] = [];
  const acc: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    acc.push(segs[i]);
    if (skipData && i === 0) continue;
    const full = acc.join("/");
    const last = i === segs.length - 1;
    const name = displaySegment(segs[i], full, boxNames, titleByPath, titleById);
    // First-level notebook (box id or box-id.sy): never flatten, never show digits.
    if (isNotebookSeg(segs[i], i, skipData)) {
      const label = isHumanLabel(name) ? name : boxNames?.[stripSy(segs[i])]?.trim() || "笔记本";
      out.push({ name: isHumanLabel(label) ? label : "笔记本", path: full });
      continue;
    }
    // Untitled document-id folders are not notebooks: flatten into the parent.
    if (!last && ID_SEG_RE.test(segs[i]) && !name) {
      continue;
    }
    out.push({ name: name || segs[i], path: full });
  }
  return out;
}

function folderMergeKey(path: string, boxNames?: Record<string, string>): string {
  return canonicalizeSiyuanPath(path, "siyuan", boxNames);
}

function ensureFolder(
  children: TreeNode[],
  name: string,
  path: string,
  boxNames?: Record<string, string>,
): TreeNode {
  const key = folderMergeKey(path, boxNames);
  let node = children.find(
    (c) => folderMergeKey(c.path, boxNames) === key && (c.kind === "folder" || c.kind === "note"),
  );
  if (!node) {
    node = { name, path, kind: "folder", children: [] };
    children.push(node);
  }
  if (!node.children) node.children = [];
  if (node.kind !== "note") {
    // Prefer a human notebook/folder name over "笔记本" or a leftover id.
    if (isHumanLabel(name) || !isHumanLabel(node.name)) node.name = name;
  }
  // Prefer the canonical box-id path so later lookups merge.
  const lastSeg = splitPath(path).at(-1) ?? "";
  if (BOX_RE.test(lastSeg) || BOX_RE.test(stripSy(lastSeg))) {
    if (node.path !== path) node.path = path;
  }
  return node;
}

function upsertLeaf(children: TreeNode[], leaf: TreeNode, boxNames?: Record<string, string>): void {
  const key = folderMergeKey(leaf.path, boxNames);
  const i = children.findIndex((c) => {
    const same = folderMergeKey(c.path, boxNames) === key;
    if (!same) return false;
    if (leaf.kind === "asset") return c.kind === "asset";
    return c.kind === "folder" || c.kind === "note";
  });
  if (i >= 0) {
    const prev = children[i];
    const kind: TreeKind =
      leaf.kind === "note" || prev.kind === "note" ? "note" : leaf.kind;
    children[i] = {
      ...prev,
      ...leaf,
      name: leaf.name || prev.name,
      kind,
      note_id: leaf.note_id ?? prev.note_id,
      asset_id: leaf.asset_id ?? prev.asset_id,
      source: leaf.source ?? prev.source,
      children: leaf.children ?? prev.children,
    };
    if (!children[i].children) children[i].children = prev.children;
    return;
  }
  children.push(leaf);
}

function insertAt(
  root: TreeNode[],
  parts: { name: string; path: string }[],
  leaf: TreeNode,
  boxNames?: Record<string, string>,
): void {
  if (!parts.length) {
    upsertLeaf(root, leaf, boxNames);
    return;
  }
  let children = root;
  for (let i = 0; i < parts.length; i++) {
    const { name, path } = parts[i];
    const last = i === parts.length - 1;
    if (last) {
      upsertLeaf(children, { ...leaf, name: leaf.name || name, path: leaf.path || path }, boxNames);
      return;
    }
    const folder = ensureFolder(children, name, path, boxNames);
    children = folder.children!;
  }
}

function sortNodes(nodes: TreeNode[]): void {
  const rank = (n: TreeNode) => {
    if (n.kind === "folder" || (n.kind === "note" && n.children?.length)) return 0;
    if (n.kind === "note") return 1;
    return 2;
  };
  nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "zh"));
  for (const n of nodes) {
    if (n.children?.length) sortNodes(n.children);
    if (n.children && !n.children.length) delete n.children;
  }
}

function parentDir(path: string): string {
  const parts = splitPath(path);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function isUnder(path: string, folder: string): boolean {
  if (!folder) return true;
  return path === folder || path.startsWith(folder + "/");
}

function visibleItems(items: TreeInput[]): TreeInput[] {
  const assetNoteIds = new Set<string>();
  for (const x of items) {
    if (x.kind !== "note") continue;
    if (isAssetNoteId(x.source_id)) {
      if (x.note_id) assetNoteIds.add(x.note_id);
    }
  }
  return items.filter((x) => {
    if (x.kind === "note") {
      if (isAssetNoteId(x.source_id)) return false;
      if (isImageLeafPath(x.path, x.title)) return false;
      if (isHiddenNotePath(x.path)) return false;
      return true;
    }
    if (x.note_id && assetNoteIds.has(x.note_id)) return false;
    if (isAssetNoteId(x.note_source_id) || isAssetNoteId(x.source_id)) return false;
    return true;
  });
}

function titleIndexes(
  notes: TreeInput[],
  boxNames?: Record<string, string>,
): { titleByPath: Map<string, string>; titleById: Map<string, string> } {
  const titleByPath = new Map<string, string>();
  const titleById = new Map<string, string>();
  for (const n of notes) {
    const t = (n.title ?? "").trim();
    if (!t || !n.path) continue;
    if (ID_SEG_RE.test(t) || isImageLeafPath(n.path, t)) continue;
    const original = posixPath(n.path);
    const canon = canonicalizeSiyuanPath(original, n.source, boxNames);
    titleByPath.set(original, t);
    titleByPath.set(canon, t);
    const leaf = splitPath(canon).at(-1) ?? splitPath(original).at(-1) ?? "";
    if (ID_SEG_RE.test(leaf)) titleById.set(stripSy(leaf), t);
  }
  return { titleByPath, titleById };
}

function leafDisplayName(n: TreeInput, parts: { name: string }[], path: string): string {
  const title = (n.title ?? "").trim();
  if (title && !ID_SEG_RE.test(title) && !isImageLeafPath(title)) return title;
  const fallback = parts.at(-1)?.name || splitPath(path).at(-1) || n.path;
  if (fallback && !ID_SEG_RE.test(fallback) && !isImageLeafPath(fallback)) return fallback;
  return "笔记";
}

function buildOneTree(items: TreeInput[], boxNames?: Record<string, string>, defaultSource?: string): TreeNode[] {
  const filtered = visibleItems(items);
  const notes = filtered.filter((x) => x.kind === "note" && x.path);
  const assets = filtered.filter((x) => x.kind === "asset" && x.path);
  const { titleByPath, titleById } = titleIndexes(notes, boxNames);
  const root: TreeNode[] = [];

  for (const n of notes) {
    const source = n.source ?? defaultSource;
    // Walk the original path so a human first segment (only code / 面试) stays a label
    // even if boxNames reverse-lookup fails. Merge still uses the canonical box id.
    const original = posixPath(n.path);
    const path = canonicalizeSiyuanPath(original, source, boxNames);
    const parts = walkParts(original, source, boxNames, titleByPath, titleById);
    insertAt(
      root,
      parts,
      {
        name: leafDisplayName(n, parts, original),
        path,
        kind: "note",
        note_id: n.note_id,
        source,
      },
      boxNames,
    );
  }

  for (const a of assets) {
    const source = a.source ?? defaultSource;
    const path = canonicalizeSiyuanPath(posixPath(a.path), source, boxNames);
    const notePathRaw = a.note_path ? posixPath(a.note_path) : "";
    const notePath = notePathRaw ? canonicalizeSiyuanPath(notePathRaw, source, boxNames) : "";
    const dumpAtRoot = isVaultRootAssetsPath(path, source);

    if (dumpAtRoot) {
      const nestUnderSy = source === "siyuan" || shouldCanonSiyuan(source, boxNames);
      if (nestUnderSy) {
        if (!isRealSiyuanDocPath(notePathRaw) && !isRealSiyuanDocPath(notePath)) continue;
        const filename = splitPath(path).at(-1) || path;
        const nested = `${notePath}/${filename}`;
        insertAt(
          root,
          walkParts(nested, source, boxNames, titleByPath, titleById),
          {
            name: filename,
            path: nested,
            kind: "asset",
            note_id: a.note_id,
            asset_id: a.asset_id,
            source,
          },
          boxNames,
        );
        continue;
      }
    }

    const alreadyUnderNote =
      Boolean(notePath) &&
      (path === notePath ||
        isUnder(path, notePath) ||
        (Boolean(parentDir(notePath)) && isUnder(path, parentDir(notePath))));
    const skipOriginal = dumpAtRoot && Boolean(notePath);

    if (!skipOriginal) {
      insertAt(
        root,
        walkParts(path, source, boxNames, titleByPath, titleById),
        {
          name: splitPath(path).at(-1) || path,
          path,
          kind: "asset",
          note_id: a.note_id,
          asset_id: a.asset_id,
          source,
        },
        boxNames,
      );
    }

    if (!notePath) continue;
    if (alreadyUnderNote && !skipOriginal) continue;
    if (path === notePath || isUnder(path, notePath)) continue;
    const filename = splitPath(path).at(-1) || path;
    const nested = `${notePath}/${filename}`;
    insertAt(
      root,
      walkParts(nested, source, boxNames, titleByPath, titleById),
      {
        name: filename,
        path: nested,
        kind: "asset",
        note_id: a.note_id,
        asset_id: a.asset_id,
        source,
      },
      boxNames,
    );
  }

  sortNodes(root);
  return root;
}

/** Nested folder/note/asset tree from note paths + asset source_paths. */
export function buildFileTree(items: TreeInput[], opts?: BuildFileTreeOpts): TreeNode[] {
  const filtered = visibleItems(items);
  if (!opts?.groupBySource) {
    return buildOneTree(filtered, opts?.boxNames);
  }

  const groups = new Map<
    string,
    { name: string; source?: string; items: TreeInput[]; boxNames?: Record<string, string> }
  >();
  for (const item of filtered) {
    const key = sourceGroupKey(item);
    let g = groups.get(key);
    if (!g) {
      g = {
        name: sourceRootName(item),
        source: item.source,
        items: [],
        boxNames: opts.boxNamesByConnection?.[key] ?? opts.boxNames,
      };
      groups.set(key, g);
    }
    g.items.push(item);
  }

  const roots: TreeNode[] = [];
  for (const [key, g] of groups) {
    const children = buildOneTree(g.items, g.boxNames, g.source);
    roots.push({
      name: g.name,
      path: `conn:${key}`,
      kind: "folder",
      source: g.source,
      children,
    });
  }
  sortNodes(roots);
  return roots;
}

/** Paths to auto-expand (first `levels` folder depths). Skips assets dumps. */
export function expandTreeLevels(nodes: TreeNode[], levels = 2, depth = 0, acc: Set<string> = new Set()): Set<string> {
  if (depth >= levels) return acc;
  for (const n of nodes) {
    if (!n.children?.length) continue;
    if (isAssetsDumpName(n.name)) continue;
    acc.add(n.path);
    expandTreeLevels(n.children, levels, depth + 1, acc);
  }
  return acc;
}
