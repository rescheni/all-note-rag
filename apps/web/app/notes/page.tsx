"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, apiOrigin, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { IconAsset, IconChevron, IconNote } from "../icons";

type Note = { id: string; title: string; path: string; updated_at: string };

export type TreeNode = {
  name: string;
  path: string;
  kind: "folder" | "note" | "asset";
  note_id?: string;
  asset_id?: string;
  source?: string;
  children?: TreeNode[];
};

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function expandLevels(nodes: TreeNode[], levels = 2, depth = 0, acc: Set<string> = new Set()): Set<string> {
  if (depth >= levels) return acc;
  for (const n of nodes) {
    if (!n.children?.length) continue;
    const dump = n.kind === "folder" && (n.name.trim().toLowerCase() === "assets" || n.name.trim() === "附件");
    if (dump) continue;
    acc.add(n.path);
    expandLevels(n.children, levels, depth + 1, acc);
  }
  return acc;
}

function TreeKids({
  nodes,
  open,
  current,
  onFolder,
  onAsset,
  expanded,
}: {
  nodes: TreeNode[];
  open: Set<string>;
  current: string;
  onFolder: (path: string) => void;
  onAsset: (node: TreeNode) => void;
  expanded: boolean;
}) {
  return (
    <div className={`tree-kids ${expanded ? "open" : ""}`}>
      <div className="tree-kids-inner">
        <TreeBranch nodes={nodes} open={open} current={current} onFolder={onFolder} onAsset={onAsset} />
      </div>
    </div>
  );
}

function TreeBranch({
  nodes,
  open,
  current,
  onFolder,
  onAsset,
}: {
  nodes: TreeNode[];
  open: Set<string>;
  current: string;
  onFolder: (path: string) => void;
  onAsset: (node: TreeNode) => void;
}) {
  return (
    <ul className="file-tree">
      {nodes.map((n) => {
        const expanded = open.has(n.path);
        const hasKids = Boolean(n.children?.length);
        const assetLike = n.kind === "asset" || isImageName(n.name) || isImageName(n.path);
        if (assetLike) {
          return (
            <li key={n.path + (n.asset_id ?? "")}>
              <button type="button" className="tree-row" onClick={() => onAsset(n)}>
                <span className="tree-twist">
                  <IconAsset />
                </span>
                <span className="tree-name">{n.name}</span>
              </button>
            </li>
          );
        }
        if (n.kind === "folder") {
          return (
            <li key={n.path}>
              <button
                type="button"
                className={`tree-row ${current === n.path ? "active" : ""}`}
                onClick={() => onFolder(n.path)}
                aria-expanded={expanded}
              >
                <span className="tree-twist">
                  <IconChevron open={expanded} />
                </span>
                <span className="tree-name">{n.name}</span>
              </button>
              {hasKids && expanded ? (
                <TreeKids nodes={n.children!} open={open} current={current} onFolder={onFolder} onAsset={onAsset} expanded={true} />
              ) : null}
            </li>
          );
        }
        if (n.kind === "note" && n.note_id) {
          return (
            <li key={n.path}>
              <div className="tree-row-wrap">
                {hasKids ? (
                  <button
                    type="button"
                    className="tree-twist-btn"
                    aria-expanded={expanded}
                    onClick={() => onFolder(n.path)}
                  >
                    <IconChevron open={expanded} />
                  </button>
                ) : (
                  <span className="tree-twist">
                    <IconNote />
                  </span>
                )}
                <Link className={`tree-row ${current === n.path ? "active" : ""}`} href={`/notes/${n.note_id}`}>
                  <span className="tree-name">{n.name}</span>
                </Link>
              </div>
              {hasKids && expanded ? (
                <TreeKids nodes={n.children!} open={open} current={current} onFolder={onFolder} onAsset={onAsset} expanded={true} />
              ) : null}
            </li>
          );
        }
        return (
          <li key={n.path + (n.asset_id ?? "")}>
            <button type="button" className="tree-row" onClick={() => onAsset(n)}>
              <span className="tree-twist">
                <IconAsset />
              </span>
              <span className="tree-name">{n.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
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

function PathCrumbs({ folder, onGo }: { folder: string; onGo: (path: string) => void }) {
  const parts = folder.split("/").filter(Boolean);
  return (
    <nav className="crumbs" aria-label="路径">
      <button type="button" className="linkish" onClick={() => onGo("")}>
        全部
      </button>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={path}>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            {last ? (
              <span>{part}</span>
            ) : (
              <button type="button" className="linkish" onClick={() => onGo(path)}>
                {part}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [folder, setFolder] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [space, setSpace] = useState<Space | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ title: string; url: string; image: boolean } | null>(null);

  const loadFolderNotes = useCallback(async (spaceId: string, path: string) => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const n = await api<{ notes: Note[] }>(`/v1/spaces/${spaceId}/notes${q}`);
    setNotes(n.notes);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    (async () => {
      try {
        const { current } = await loadSpaces();
        if (!current) return;
        setSpace(current);
        const [n, t] = await Promise.all([
          api<{ notes: Note[] }>(`/v1/spaces/${current.id}/notes`),
          api<{ tree: TreeNode[] }>(`/v1/spaces/${current.id}/tree`).catch(() => ({ tree: [] as TreeNode[] })),
        ]);
        setNotes(n.notes);
        const nextTree = t.tree ?? [];
        setTree(nextTree);
        setOpen(expandLevels(nextTree, 2));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selectPath = (path: string, toggle = false) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (path) {
        const bits = path.split("/").filter(Boolean);
        let acc = "";
        for (const b of bits) {
          acc = acc ? `${acc}/${b}` : b;
          next.add(acc);
        }
        if (toggle && folder === path && prev.has(path)) next.delete(path);
      }
      return next;
    });
    setFolder(path);
    setPreview(null);
    if (space) void loadFolderNotes(space.id, path);
  };

  const onFolder = (path: string) => selectPath(path, true);

  const onAsset = async (node: TreeNode) => {
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
  };

  const children = useMemo(() => {
    if (!folder) return null;
    return findNode(tree, folder);
  }, [tree, folder]);

  const rightItems = children?.children ?? [];

  return (
    <>
      <h1>笔记</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {space && (
        <p className="muted">
          当前空间：{space.name}（{spaceKindLabel(space.kind)}）
        </p>
      )}
      {err && <p className="err">{err}</p>}
      <div className="notes-layout">
        <aside className="tree-pane">
          <p className="tree-pane-label">目录</p>
          {loading ? (
            <p className="muted">加载目录…</p>
          ) : tree.length ? (
            <TreeBranch nodes={tree} open={open} current={folder} onFolder={onFolder} onAsset={onAsset} />
          ) : (
            <p className="muted">同步后这里会出现源里的目录</p>
          )}
        </aside>
        <section className="notes-main">
          <PathCrumbs folder={folder} onGo={(p) => selectPath(p, false)} />
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
          {folder && rightItems.length > 0 && (
            <ul className="list">
              {rightItems.map((n) => (
                <li key={n.path + (n.asset_id ?? n.note_id ?? "")}>
                  {n.kind === "asset" || isImageName(n.name) || isImageName(n.path) ? (
                    <button type="button" className="linkish" onClick={() => onAsset(n)}>
                      {n.name}
                    </button>
                  ) : n.kind === "folder" ? (
                    <button type="button" className="linkish" onClick={() => onFolder(n.path)}>
                      {n.name}/
                    </button>
                  ) : n.kind === "note" && n.note_id ? (
                    <Link href={`/notes/${n.note_id}`}>{n.name}</Link>
                  ) : (
                    <button type="button" className="linkish" onClick={() => onAsset(n)}>
                      {n.name}
                    </button>
                  )}
                  <div className="muted">
                    {n.path}
                    {n.source ? ` · ${n.source}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(!folder || !rightItems.length) && (
            <>
              {notes.length === 0 ? (
                <p className="muted">{folder ? "这个目录下还没有笔记" : "同步后这里会出现源里的目录"}</p>
              ) : (
                <ul className="list">
                  {notes.map((n) => (
                    <li key={n.id}>
                      <Link href={`/notes/${n.id}`}>{n.title}</Link>
                      <div className="muted">{n.path}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
