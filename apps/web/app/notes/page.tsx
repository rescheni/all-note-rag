"use client";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { api, apiOrigin, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { IconAsset, IconFolder, IconNote } from "../icons";
import { useReducedMotion } from "../ui-motion";
import {
  collectPathTitles,
  primaryLabel,
  labelCrumbsFromTree,
  listPathLine,
  pathCrumbs,
  resolveCrumbs,
  tailSeg,
  titlesFromNotes,
  PathTrail,
  prettyPath,
  trailWithoutBookPrefix,
  type Crumb,
  type TrailItem,
} from "./crumbs";
import { LIST_ROW_H, TreeList, isAssetsDump, isImageName, type TreeNode } from "./tree-list";
import { WindowList } from "./window";

type Note = { id: string; title: string; path: string; updated_at: string; source_id?: string };

export type { TreeNode };

export type SourceGroup = {
  source: string;
  connection_id: string;
  name: string;
  tree: TreeNode[];
};

const SOURCE_LABEL: Record<string, string> = {
  feishu: "飞书",
  notion: "Notion",
  siyuan: "思源",
  obsidian: "Obsidian",
};
const SOURCE_ORDER = ["feishu", "notion", "siyuan", "obsidian"];

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] || source || "源";
}

function sectionsFromGroups(groups: SourceGroup[]): { source: string; label: string; groups: SourceGroup[] }[] {
  const by = new Map<string, SourceGroup[]>();
  for (const g of groups) {
    const k = g.source || "_";
    const arr = by.get(k);
    if (arr) arr.push(g);
    else by.set(k, [g]);
  }
  const keys = [...by.keys()].sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a);
    const ib = SOURCE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b, "zh");
  });
  return keys.map((source) => ({
    source,
    label: sourceLabel(source),
    groups: by.get(source)!,
  }));
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

function graft(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) {
      return { ...n, children: children.length ? children : undefined, has_children: children.length > 0 };
    }
    if (n.children?.length) return { ...n, children: graft(n.children, path, children) };
    return n;
  });
}

function nodeNeedsLoad(n: TreeNode | null): boolean {
  if (!n) return false;
  if (isAssetsDump(n.name)) return false;
  return Boolean(n.has_children) && !n.children?.length;
}

type ConnectionMeta = {
  id: string;
  name: string;
  source: string;
  status: string;
  last_sync_at: string | null;
  note_count?: number;
};

type BookMeta = { count: number; capped: boolean; lastSync: string | null; status: string };

/** Drawn source marks, one stroke weight, no emoji. */
function SourceMark({ source }: { source: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (source === "obsidian") {
    return (
      <svg className="source-mark" {...common}>
        <path d="M13 3 19.5 9.5 16 21 8 19 4.5 10.5Z" />
        <path d="M13 3 10 12l6 9M4.5 10.5 10 12" />
      </svg>
    );
  }
  if (source === "siyuan") {
    return (
      <svg className="source-mark" {...common}>
        <path d="M12 3.5c2.6 2.7 4 4.9 4 6.7a4 4 0 0 1-8 0c0-1.8 1.4-4 4-6.7Z" />
        <path d="M6 17.5c2 1.2 4 1.2 6 0s4-1.2 6 0" />
        <path d="M6 20.5c2 1.2 4 1.2 6 0s4-1.2 6 0" />
      </svg>
    );
  }
  if (source === "notion") {
    return (
      <svg className="source-mark" {...common}>
        <path d="M5.5 5h9L18.5 9v10h-13Z" />
        <path d="M14.5 5v4h4" />
        <path d="M8.5 15.5V11l5 4.5V11" />
      </svg>
    );
  }
  return (
    <svg className="source-mark" {...common}>
      <path d="M4 12.5 20 4.5l-6 15-2.5-5.5Z" />
      <path d="m11.5 14 4-6" />
    </svg>
  );
}

/** Fatter spine for a fuller book; a source with no notes stays visibly thin. */
function spineDepth(count: number | undefined): number {
  if (count === undefined) return 26;
  if (count <= 0) return 12;
  return Math.min(46, Math.round(16 + Math.log2(count + 1) * 5.2));
}

function countLabel(meta: BookMeta | undefined): string {
  if (!meta) return "清点中…";
  if (meta.count <= 0) return "还没有笔记";
  return `${meta.count}${meta.capped ? "+" : ""} 篇`;
}

function syncLabel(value: string | null | undefined): string {
  if (!value) return "尚未同步";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "已同步";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "刚刚同步";
  if (mins < 60) return `${mins} 分钟前同步`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} 小时前同步`;
  if (mins < 60 * 24 * 30) return `${Math.floor(mins / 1440)} 天前同步`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月 同步`;
}

/** Cover open/close timings — mirrored in globals.css keyframes. */
const BOOK_OPEN_MS = 860;
const BOOK_CLOSE_MS = 760;

const VOLUME_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * Idle shelf is plain DOM + CSS (no framer springs on every book).
 * Motion work only runs while a book is opening/closing via CSS keyframes.
 */
const SourceBook = memo(function SourceBook({
  group,
  meta,
  index,
  volume,
  opening,
  closing,
  skipEnter,
  onOpen,
}: {
  group: SourceGroup;
  meta: BookMeta | undefined;
  index: number;
  volume: number;
  opening: boolean;
  closing: boolean;
  skipEnter: boolean;
  onOpen: (connectionId: string) => void;
}) {
  const empty = meta ? meta.count <= 0 : false;
  const depth = spineDepth(meta?.count);
  const label = countLabel(meta);
  const volumeMark = volume > 0 ? `卷${VOLUME_CN[volume] ?? volume}` : "";
  return (
    <div
      className={`shelf-slot${skipEnter ? " skip-enter" : ""}`}
      style={{ "--slot-i": index } as CSSProperties}
    >
      <button
        type="button"
        className={`source-book${empty ? " is-empty" : ""}${opening ? " is-opening" : ""}${closing ? " is-closing" : ""}`}
        data-source={group.source}
        style={
          {
            "--spine-depth": `${depth}px`,
            "--cover-shade": `rgba(60, 51, 44, ${Math.max(0, volume - 1) * 0.1})`,
          } as CSSProperties
        }
        onClick={() => onOpen(group.connection_id)}
        aria-label={`打开${sourceLabel(group.source)}｜${group.name}${volumeMark ? ` ${volumeMark}` : ""}，${label}`}
      >
        <span className="book-volume" aria-hidden="true">
          <span className="book-board" />
          <span className="book-pages">
            <i /><i /><i /><i />
          </span>
          <span className="book-leaf">
            <span className="book-leaf-label">目录</span>
            <span className="book-leaf-lines" />
          </span>
          <span className="book-spine">
            <span className="book-spine-text">
              {sourceLabel(group.source)}
              {volumeMark ? <em>{volumeMark}</em> : null}
            </span>
          </span>
          <span className="book-cover">
            <span className="book-cover-face">
              <span className="book-cover-top">
                <SourceMark source={group.source} />
                <span className="book-cover-source">{sourceLabel(group.source)}</span>
                {volumeMark ? <span className="book-cover-volume">{volumeMark}</span> : null}
              </span>
              <span className="book-cover-title">{group.name}</span>
              <span className="book-cover-foot">
                <span className="book-cover-count">{label}</span>
                <span className="book-cover-sync">{syncLabel(meta?.lastSync)}</span>
              </span>
            </span>
            <span className="book-cover-inside">
              <span className="book-cover-inside-plate">{sourceLabel(group.source)}</span>
            </span>
          </span>
        </span>
        <span className="book-shade" aria-hidden="true" />
      </button>
    </div>
  );
});


function notesListUrl(book: string, path: string): string {
  const u = new URL("/notes", "http://local.invalid");
  if (book) u.searchParams.set("book", book);
  if (path) u.searchParams.set("path", path);
  return u.pathname + u.search;
}

/** Push/replace so browser 返回 walks book → folder → parent, not straight to shelf. */
function syncNotesUrl(book: string, path: string, mode: "push" | "replace") {
  if (typeof window === "undefined") return;
  const next = notesListUrl(book, path);
  const cur = window.location.pathname + window.location.search;
  if (cur === next) {
    if (mode === "replace") window.history.replaceState({ book, path }, "", next);
    return;
  }
  if (mode === "push") window.history.pushState({ book, path }, "", next);
  else window.history.replaceState({ book, path }, "", next);
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [recent, setRecent] = useState<Note[]>([]);
  const [groups, setGroups] = useState<SourceGroup[]>([]);
  const [folder, setFolder] = useState("");
  const [source, setSource] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [space, setSpace] = useState<Space | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ title: string; url: string; image: boolean } | null>(null);
  const [meta, setMeta] = useState<Record<string, BookMeta>>({});
  const [openedId, setOpenedId] = useState("");
  const [openingId, setOpeningId] = useState("");
  const [closingId, setClosingId] = useState("");
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = useRef<{ book: string; path: string } | null>(null);
  const reduced = useReducedMotion();
  const live = useRef({
    space: null as Space | null,
    groups: [] as SourceGroup[],
    folder: "",
    source: "",
    connectionId: "",
  });
  live.current = { space, groups, folder, source, connectionId };

  const loadFolderNotes = useCallback(
    async (spaceId: string, path: string, connId?: string, src?: string) => {
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      if (connId) params.set("connection_id", connId);
      else if (src) params.set("source", src);
      const q = params.toString() ? `?${params}` : "";
      const n = await api<{ notes: Note[] }>(`/v1/spaces/${spaceId}/notes${q}`);
      setNotes(n.notes);
    },
    [],
  );

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    try {
      const q = new URLSearchParams(window.location.search);
      const book = q.get("book") ?? "";
      if (book) wanted.current = { book, path: q.get("path") ?? "" };
    } catch {
      /* no deep link */
    }
    (async () => {
      try {
        const { current } = await loadSpaces();
        if (!current) return;
        setSpace(current);
        const [t, c, r] = await Promise.all([
          api<{ groups?: SourceGroup[]; tree?: TreeNode[] }>(`/v1/spaces/${current.id}/tree`).catch(
            () => ({ groups: [] as SourceGroup[], tree: [] as TreeNode[] }),
          ),
          api<{ connections: ConnectionMeta[] }>(`/v1/spaces/${current.id}/connections`).catch(
            () => ({ connections: [] as ConnectionMeta[] }),
          ),
          api<{ notes: Note[] }>(`/v1/spaces/${current.id}/notes`).catch(() => ({ notes: [] as Note[] })),
        ]);
        setRecent(r.notes.slice(0, 6));
        const nextGroups = t.groups ?? [];
        setGroups(nextGroups);
        setLoading(false);
        const want = wanted.current;
        if (want) {
          wanted.current = null;
          const hit = nextGroups.find((g) => g.connection_id === want.book);
          if (hit) {
            setOpenedId(hit.connection_id);
            setSource(hit.source);
            setConnectionId(hit.connection_id);
            if (want.path) {
              const bits = want.path.split("/").filter(Boolean);
              const acc: string[] = [];
              const levels: string[] = [];
              for (const b of bits) {
                acc.push(b);
                levels.push(acc.join("/"));
              }
              setOpen(new Set(levels));
              setFolder(want.path);
              void loadFolderNotes(current.id, want.path, hit.connection_id);
              // 逐层取回目录，面包屑和树才都有真名字。
              // 源里存的前缀有时是 id、有时是标题，所以按末段在树里找真正的节点路径。
              void (async () => {
                let children: TreeNode[] = hit.tree ?? [];
                const realLevels: string[] = [];
                for (const level of levels) {
                  const seg = tailSeg(level);
                  const node =
                    children.find((n) => tailSeg(n.path) === seg && n.kind !== "note") ??
                    children.find((n) => tailSeg(n.path) === seg);
                  const target = node?.path ?? level;
                  realLevels.push(target);
                  const q2 = `?connection_id=${encodeURIComponent(hit.connection_id)}&parent=${encodeURIComponent(target)}`;
                  const r2 = await api<{ tree?: TreeNode[] }>(
                    `/v1/spaces/${current.id}/tree${q2}`,
                  ).catch(() => ({ tree: [] as TreeNode[] }));
                  patchGroupTree(hit.connection_id, target, r2.tree ?? []);
                  children = r2.tree ?? [];
                }
                setOpen(new Set([...levels, ...realLevels]));
              })();
            } else {
              void loadFolderNotes(current.id, "", hit.connection_id);
            }
          }
        }
        // connections already carry SQL note_count — avoid N× full /notes payloads just to tally spines.
        const counted = nextGroups.map((g) => {
          const conn = c.connections.find((x) => x.id === g.connection_id);
          const n = Number(conn?.note_count ?? 0);
          const entry: BookMeta = {
            count: n,
            capped: false,
            lastSync: conn?.last_sync_at ?? null,
            status: conn?.status ?? "",
          };
          return [g.connection_id, entry] as const;
        });
        startTransition(() => setMeta(Object.fromEntries(counted)));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
        setLoading(false);
      }
    })();
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    };
  }, []);

  const patchGroupTree = useCallback((connId: string, path: string, children: TreeNode[]) => {
    setGroups((prev) =>
      prev.map((g) => (g.connection_id === connId ? { ...g, tree: graft(g.tree, path, children) } : g)),
    );
  }, []);

  const ensureChildren = useCallback(
    async (path: string, connId: string) => {
      const { space: sp, groups: gs } = live.current;
      if (!sp || !path) return;
      const group = gs.find((g) => g.connection_id === connId);
      const node = group ? findNode(group.tree, path) : null;
      if (!nodeNeedsLoad(node)) return;
      try {
        const q = `?connection_id=${encodeURIComponent(connId)}&parent=${encodeURIComponent(path)}`;
        const r = await api<{ tree: TreeNode[] }>(`/v1/spaces/${sp.id}/tree${q}`);
        patchGroupTree(connId, path, r.tree ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "无法展开目录");
      }
    },
    [patchGroupTree],
  );

  const selectPath = useCallback(
    (path: string, opts: { toggle?: boolean; connectionId?: string; source?: string; history?: "push" | "replace" | "none" } = {}) => {
      const cur = live.current;
      const connId = opts.connectionId ?? cur.connectionId;
      const src = opts.source ?? cur.source;
      const hist = opts.history ?? "push";
      setOpen((prev) => {
        const next = new Set(prev);
        if (path) {
          const bits = path.split("/").filter(Boolean);
          let acc = "";
          for (const b of bits) {
            acc = acc ? `${acc}/${b}` : b;
            next.add(acc);
          }
          if (opts.toggle && cur.folder === path && prev.has(path)) next.delete(path);
        }
        if (next.size === prev.size) {
          let same = true;
          for (const x of next) {
            if (!prev.has(x)) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
      setFolder(path);
      setSource(src);
      setConnectionId(connId);
      setPreview(null);
      const bookId = connId || cur.connectionId;
      if (bookId && hist !== "none") syncNotesUrl(bookId, path, hist === "replace" ? "replace" : "push");
      // Prefer tree kids for the right pane; only hit /notes when at book root or kids unknown.
      const group = cur.groups.find((g) => g.connection_id === (connId || cur.connectionId));
      const node = path && group ? findNode(group.tree, path) : null;
      const hasLocalKids = Boolean(node?.children?.length);
      if (cur.space && (!path || !hasLocalKids)) {
        void loadFolderNotes(cur.space.id, path, connId || undefined, src || undefined);
      } else if (!path) {
        setNotes([]);
      }
      if (path && connId) void ensureChildren(path, connId);
    },
    [loadFolderNotes, ensureChildren],
  );


  useEffect(() => {
    const onPop = () => {
      try {
        const q = new URLSearchParams(window.location.search);
        const book = q.get("book") ?? "";
        const path = q.get("path") ?? "";
        const cur = live.current;
        if (!book) {
          if (openTimer.current) clearTimeout(openTimer.current);
          setFolder("");
          setSource("");
          setConnectionId("");
          setOpen(new Set());
          setPreview(null);
          setNotes([]);
          setOpeningId("");
          setClosingId("");
          setOpenedId("");
          return;
        }
        const group = cur.groups.find((g) => g.connection_id === book);
        if (!group) return;
        setOpenedId(book);
        setOpeningId("");
        setClosingId("");
        setSource(group.source);
        setConnectionId(book);
        setPreview(null);
        if (path) {
          const bits = path.split("/").filter(Boolean);
          const levels: string[] = [];
          let acc = "";
          for (const b of bits) {
            acc = acc ? `${acc}/${b}` : b;
            levels.push(acc);
          }
          setOpen(new Set(levels));
          setFolder(path);
        } else {
          setOpen(new Set());
          setFolder("");
        }
        if (cur.space) void loadFolderNotes(cur.space.id, path, book, group.source);
        if (path) void ensureChildren(path, book);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loadFolderNotes, ensureChildren]);

  const onFolder = useCallback(
    (path: string, connId: string) => {
      const group = live.current.groups.find((g) => g.connection_id === connId);
      selectPath(path, { toggle: true, connectionId: connId, source: group?.source || live.current.source });
    },
    [selectPath],
  );

  const onSelectTree = useCallback(
    (path: string, connId: string) => {
      const group = live.current.groups.find((g) => g.connection_id === connId);
      selectPath(path, { connectionId: connId, source: group?.source || live.current.source });
    },
    [selectPath],
  );

  const onAsset = useCallback(async (node: TreeNode) => {
    if (!node.note_id) return;
    const token = getToken();
    const assetPath = node.name;
    const url = `${apiOrigin()}/v1/notes/${node.note_id}/assets?path=${encodeURIComponent(assetPath)}`;
    try {
      const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "include" });
      if (!res.ok) throw new Error("无法打开附件");
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      setPreview({ title: node.name, url: obj, image: isImageName(node.name) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "无法打开附件");
    }
  }, []);

  const shelf = useMemo(
    () =>
      sectionsFromGroups(groups).flatMap((sec) =>
        sec.groups.map((group, i) => ({ group, volume: sec.groups.length > 1 ? i + 1 : 0 })),
      ),
    [groups],
  );
  const shelfTally = useMemo(() => {
    const counted = shelf.filter((b) => meta[b.group.connection_id]);
    const total = counted.reduce((sum, b) => sum + (meta[b.group.connection_id]?.count ?? 0), 0);
    const capped = counted.some((b) => meta[b.group.connection_id]?.capped);
    return {
      sources: new Set(shelf.map((b) => b.group.source)).size,
      notes: counted.length === shelf.length ? `${total}${capped ? "+" : ""} 篇` : "",
    };
  }, [shelf, meta]);
  const openedBook = useMemo(
    () => groups.find((g) => g.connection_id === openedId) ?? null,
    [groups, openedId],
  );

  const children = useMemo(() => {
    if (!folder) return null;
    for (const g of groups) {
      if (connectionId && g.connection_id !== connectionId) continue;
      const hit = findNode(g.tree, folder);
      if (hit) return hit;
    }
    return null;
  }, [groups, folder, connectionId]);
  const rightItems = children?.children ?? [];

  const folderTrail = useMemo<Crumb[]>(() => {
    if (!openedBook || !folder) return [];
    const titles = titlesFromNotes(notes, collectPathTitles(openedBook.tree));
    const crumbs = resolveCrumbs(
      labelCrumbsFromTree(openedBook.tree, pathCrumbs(folder)),
      titles,
    );
    // Path roots often reuse the connection/book name already shown after 书架.
    return trailWithoutBookPrefix(crumbs, openedBook.name);
  }, [openedBook, folder, notes]);

  /** Same id→title map PathTrail uses — list path lines must resolve, not echo hashes. */
  const pathTitles = useMemo(
    () =>
      openedBook
        ? titlesFromNotes(notes, collectPathTitles(openedBook.tree))
        : titlesFromNotes(notes, titlesFromNotes(recent)),
    [openedBook, notes, recent],
  );

  const clearDesk = () => {
    setFolder("");
    setSource("");
    setConnectionId("");
    setOpen(new Set());
    setPreview(null);
    setNotes([]);
  };

  const openBookById = useCallback(
    (connectionId: string) => {
      if (openingId || closingId) return;
      const group = live.current.groups.find((g) => g.connection_id === connectionId);
      if (!group) return;
      selectPath("", { connectionId: group.connection_id, source: group.source });
      if (reduced) {
        setOpenedId(group.connection_id);
        setOpeningId("");
        setClosingId("");
        return;
      }
      setClosingId("");
      setOpeningId(group.connection_id);
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => {
        startTransition(() => {
          setOpenedId(group.connection_id);
          setOpeningId("");
        });
      }, BOOK_OPEN_MS);
    },
    [openingId, closingId, reduced, selectPath],
  );

  const closeBook = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    const id = openedId || openingId;
    syncNotesUrl("", "", "push");
    clearDesk();
    if (reduced || !id) {
      setOpeningId("");
      setClosingId("");
      setOpenedId("");
      return;
    }
    setOpenedId("");
    setOpeningId("");
    setClosingId(id);
    openTimer.current = setTimeout(() => setClosingId(""), BOOK_CLOSE_MS);
  };

  const openedMeta = openedBook ? meta[openedBook.connection_id] : undefined;

  return (
    <div className="library">
      <div className="library-head">
        <div>
          <h1>{openedBook ? openedBook.name : "笔记"}</h1>
          <p className="readonly-banner">
            {openedBook
              ? sourceLabel(openedBook.source)
              : "一个源，一本书。点开即读。"}
          </p>
        </div>
        {space ? (
          <p className="library-space">
            {space.name}
            <span aria-hidden="true"> · </span>
            {spaceKindLabel(space.kind)}
          </p>
        ) : null}
      </div>
      {err && <p className="err">{err}</p>}

      {openedBook ? (
        <div key="reading" className="stage-reading">
          <div className="reading-bar">
            <button
              type="button"
              className="back-to-shelf"
              onClick={() => {
                if (!folder) {
                  closeBook();
                  return;
                }
                const crumbs = pathCrumbs(folder);
                if (crumbs.length <= 1) {
                  selectPath("", {
                    connectionId: openedBook.connection_id,
                    source: openedBook.source,
                    history: "replace",
                  });
                  return;
                }
                const parent = crumbs[crumbs.length - 2]!;
                selectPath(parent.path, {
                  connectionId: openedBook.connection_id,
                  source: openedBook.source,
                  history: "replace",
                });
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M9.5 3.5 5.5 8l4 4.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {folder ? "返回" : "放回书架"}
            </button>
            <span className="reading-meta">{countLabel(openedMeta)}</span>
            <span className="reading-meta">{syncLabel(openedMeta?.lastSync)}</span>
          </div>
          <div className="notes-layout">
            <aside className="tree-pane">
              <div className="reading-plate" data-source={openedBook.source}>
                <SourceMark source={openedBook.source} />
                <span>{sourceLabel(openedBook.source)}</span>
              </div>
              <button
                type="button"
                className={`source-section-head${folder ? "" : " active"}`}
                onClick={() =>
                  selectPath("", { connectionId: openedBook.connection_id, source: openedBook.source })
                }
              >
                <span className="tree-twist">
                  <IconNote />
                </span>
                <span className="source-section-name">全部笔记</span>
              </button>
              {openedBook.tree.length ? (
                <TreeList
                  nodes={openedBook.tree}
                  open={open}
                  current={folder}
                  connectionId={openedBook.connection_id}
                  titles={pathTitles}
                  onFolder={onFolder}
                  onSelect={onSelectTree}
                  onAsset={onAsset}
                />
              ) : (
                <p className="source-section-empty">还没有笔记，同步后这里会出现源里的目录。</p>
              )}
            </aside>
            <section className="notes-main">
              <PathTrail
                items={[
                  { key: "shelf", label: "书架", title: "回到书架", onSelect: closeBook, root: true },
                  ...(folder
                    ? [
                        {
                          key: "book",
                          label: openedBook.name,
                          title: `${sourceLabel(openedBook.source)} · ${openedBook.name}`,
                          onSelect: () =>
                            selectPath("", {
                              connectionId: openedBook.connection_id,
                              source: openedBook.source,
                            }),
                        } as TrailItem,
                      ]
                    : []),
                  ...folderTrail.slice(0, -1).map<TrailItem>((c) => ({
                    key: c.path,
                    label: c.label,
                    title: prettyPath(c.path) || c.label,
                    onSelect: () =>
                      selectPath(c.path, {
                        connectionId: openedBook.connection_id,
                        source: openedBook.source,
                      }),
                  })),
                ]}
                current={folder ? folderTrail[folderTrail.length - 1]?.label ?? "" : openedBook.name}
                currentTitle={
                  folder
                    ? prettyPath(folder, folderTrail[folderTrail.length - 1]?.label) ||
                      folderTrail[folderTrail.length - 1]?.label ||
                      openedBook.name
                    : `${sourceLabel(openedBook.source)} · ${openedBook.name}`
                }
              />
              {preview && (
                <div className="asset-preview">
                  <div className="muted">{preview.title}</div>
                  {preview.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview.url} alt={preview.title} />
                  ) : (
                    <a className="btn secondary" href={preview.url} download={preview.title}>
                      下载 {preview.title}
                    </a>
                  )}
                </div>
              )}
              {folder && rightItems.length > 0 ? (
                <WindowList
                  className="notes-window list"
                  items={rightItems}
                  rowHeight={LIST_ROW_H}
                  overscan={10}
                  role="list"
                  ariaLabel="目录条目"
                  renderRow={(n) => {
                    const title = primaryLabel(n.name, {
                      path: n.path,
                      titles: pathTitles,
                      title: n.name,
                      fallback: "未命名",
                    });
                    const assetLike = n.kind === "asset" || isImageName(n.name) || isImageName(n.path);
                    const pathLine = listPathLine(n.path, pathTitles, {
                      title,
                      tree: openedBook?.tree,
                      keep: 3,
                      dropTrailingTitle: true,
                    });
                    const src = n.source || source;
                    const srcLabel = src ? sourceLabel(src) : "";
                    const fullPath =
                      listPathLine(n.path, pathTitles, {
                        title,
                        tree: openedBook?.tree,
                        keep: 8,
                        dropTrailingTitle: false,
                      }) || title;
                    const lead = n.icon ? (
                      <span className="notes-row-emoji" aria-hidden="true">
                        {n.icon}
                      </span>
                    ) : assetLike ? (
                      <IconAsset />
                    ) : n.kind === "folder" ? (
                      <IconFolder />
                    ) : (
                      <IconNote />
                    );
                    const titleNode = assetLike ? (
                      <button type="button" className="linkish notes-row-link" onClick={() => onAsset(n)}>
                        {title}
                      </button>
                    ) : n.kind === "folder" ? (
                      <button
                        type="button"
                        className="linkish notes-row-link"
                        onClick={() => onFolder(n.path, connectionId)}
                      >
                        {title}
                      </button>
                    ) : n.kind === "note" && n.note_id ? (
                      <Link className="notes-row-link" href={`/notes/${n.note_id}`}>
                        {title}
                      </Link>
                    ) : (
                      <button type="button" className="linkish notes-row-link" onClick={() => onAsset(n)}>
                        {title}
                      </button>
                    );
                    return (
                      <div
                        className="notes-window-row"
                        key={n.path + (n.asset_id ?? n.note_id ?? "")}
                        role="listitem"
                      >
                        <span className="notes-row-lead">{lead}</span>
                        <div className="notes-row-main">
                          <div className="notes-row-title">{titleNode}</div>
                          {pathLine || srcLabel ? (
                            <div className="muted note-path" title={fullPath}>
                              {pathLine ? <span>{pathLine}</span> : null}
                              {pathLine && srcLabel ? <span aria-hidden="true"> · </span> : null}
                              {srcLabel ? (
                                <span className="notes-row-source" data-source={src}>
                                  {srcLabel}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  }}
                />
              ) : notes.length === 0 ? (
                <p className="empty-desk">
                  {folder ? "这个目录下还没有笔记" : "这本书还没有笔记，同步后会出现在这里"}
                </p>
              ) : (
                <WindowList
                  className="notes-window list"
                  items={notes}
                  rowHeight={LIST_ROW_H}
                  overscan={10}
                  role="list"
                  ariaLabel="笔记列表"
                  renderRow={(n) => {
                    const title = primaryLabel(n.title, {
                      path: n.path,
                      titles: pathTitles,
                      title: n.title,
                      fallback: "未命名",
                    });
                    const pathLine = listPathLine(n.path, pathTitles, {
                      title: title,
                      tree: openedBook?.tree,
                      keep: 3,
                      dropTrailingTitle: true,
                    });
                    const fullPath =
                      listPathLine(n.path, pathTitles, {
                        title,
                        tree: openedBook?.tree,
                        keep: 8,
                        dropTrailingTitle: false,
                      }) || title;
                    const src = source;
                    const srcLabel = src ? sourceLabel(src) : "";
                    return (
                      <div className="notes-window-row" key={n.id} role="listitem">
                        <span className="notes-row-lead">
                          <IconNote />
                        </span>
                        <div className="notes-row-main">
                          <div className="notes-row-title">
                            <Link className="notes-row-link" href={`/notes/${n.id}`}>
                              {title}
                            </Link>
                          </div>
                          {pathLine || srcLabel ? (
                            <div className="muted note-path" title={fullPath}>
                              {pathLine ? <span>{pathLine}</span> : null}
                              {pathLine && srcLabel ? <span aria-hidden="true"> · </span> : null}
                              {srcLabel ? (
                                <span className="notes-row-source" data-source={src}>
                                  {srcLabel}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  }}
                />
              )}
            </section>
          </div>
        </div>
      ) : (
        <div key="shelf" className="stage-shelf">
          {loading ? (
            <div className="shelf-loading" aria-label="正在整理书架">
              {[0, 1, 2, 3].map((n) => (
                <span key={n} />
              ))}
            </div>
          ) : shelf.length ? (
            <>
              <div className={`bookshelf${openingId || closingId ? " is-opening" : ""}`}>
                {shelf.map(({ group, volume }, i) => (
                  <SourceBook
                    key={group.connection_id}
                    group={group}
                    meta={meta[group.connection_id]}
                    index={i}
                    volume={volume}
                    opening={openingId === group.connection_id}
                    closing={closingId === group.connection_id}
                    skipEnter={Boolean(closingId)}
                    onOpen={openBookById}
                  />
                ))}
              </div>
              <p className="shelf-hint">
                点一本书，翻开它的目录
                <span>{shelf.length} 本</span>
                <span>{shelfTally.sources} 个源</span>
                {shelfTally.notes ? <span>{shelfTally.notes}</span> : null}
              </p>
              {(space?.role === "owner" || space?.role === "editor") && (
                <p className="shelf-readd">
                  {SOURCE_ORDER.filter((s) => shelf.some((x) => x.group.source === s)).map((s) => (
                    <Link key={s} href={`/connections/new?source=${s}`}>
                      再接入{sourceLabel(s)}
                    </Link>
                  ))}
                  <Link href="/connections">管理来源</Link>
                </p>
              )}
              {recent.length ? (
                <section className="shelf-recent">
                  <h2>最近改动</h2>
                  <ul className="list">
                    {recent.map((n) => {
                      const title = primaryLabel(n.title, {
                        path: n.path,
                        titles: pathTitles,
                        title: n.title,
                        fallback: "未命名",
                      });
                      const pathLine = listPathLine(n.path, pathTitles, {
                        title: title,
                        keep: 3,
                        dropTrailingTitle: true,
                      });
                      return (
                        <li key={n.id}>
                          <Link href={`/notes/${n.id}`}>{title}</Link>
                          <div
                            className="muted note-path"
                            title={
                              listPathLine(n.path, pathTitles, {
                                title: n.title,
                                keep: 8,
                                dropTrailingTitle: false,
                              }) || title
                            }
                          >
                            {pathLine || title}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </>
          ) : (
            <div className="shelf-vacant">
              <p>书架上还没有书。</p>
              <p className="muted">接入一个源并同步，它就会成为这里的第一本。</p>
              <p>
                <Link href="/connections/new">去接入源</Link>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
