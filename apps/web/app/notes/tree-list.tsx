"use client";

import { memo, useCallback, useMemo, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconAsset, IconChevron, IconNote } from "../icons";
import { primaryLabel } from "./crumbs";
import { WindowList } from "./window";

export type TreeNode = {
  name: string;
  path: string;
  kind: "folder" | "note" | "asset";
  note_id?: string;
  asset_id?: string;
  source?: string;
  /** Display emoji from note frontmatter.icon when present. */
  icon?: string | null;
  has_children?: boolean;
  children?: TreeNode[];
};

export type FlatRow = { node: TreeNode; depth: number };

export const TREE_ROW_H = 28;
export const LIST_ROW_H = 68;

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function isAssetsDump(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "assets" || n === "附件";
}

export function flattenVisible(nodes: TreeNode[], open: Set<string>, depth = 0): FlatRow[] {
  const out: FlatRow[] = [];
  for (const n of nodes) {
    if (n.kind === "folder" && isAssetsDump(n.name)) continue;
    out.push({ node: n, depth });
    if (open.has(n.path) && n.children?.length) {
      out.push(...flattenVisible(n.children, open, depth + 1));
    }
  }
  return out;
}

function labelOf(n: TreeNode, titles?: Record<string, string>): string {
  return primaryLabel(n.name, {
    path: n.path,
    titles,
    title: n.name,
    fallback: "未命名",
  });
}

function NoteLead({ icon, hasKids, expanded, onExpand }: {
  icon?: string | null;
  hasKids: boolean;
  expanded: boolean;
  onExpand?: () => void;
}) {
  if (hasKids) {
    return (
      <button
        type="button"
        className="tree-twist-btn"
        aria-expanded={expanded}
        onClick={onExpand}
        tabIndex={-1}
      >
        <IconChevron open={expanded} />
      </button>
    );
  }
  if (icon) return <span className="tree-emoji" aria-hidden="true">{icon}</span>;
  return <IconNote />;
}

/** Shared shell: depth indent via --d only; fixed lead slot then name. */
function TreeShell({
  depth,
  active,
  expanded,
  lead,
  children,
}: {
  depth: number;
  active: boolean;
  expanded?: boolean;
  lead: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="tree-window-row"
      style={{ ["--d" as string]: String(depth) }}
      role="treeitem"
      aria-selected={active}
      aria-expanded={expanded}
    >
      <div className="tree-row-wrap">
        <span className="tree-lead">{lead}</span>
        {children}
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  row,
  current,
  expanded,
  connectionId,
  titles,
  onFolder,
  onAsset,
}: {
  row: FlatRow;
  current: string;
  expanded: boolean;
  connectionId: string;
  titles?: Record<string, string>;
  onFolder: (path: string, connectionId: string) => void;
  onAsset: (node: TreeNode) => void;
}) {
  const n = row.node;
  const hasKids = Boolean(n.children?.length) || Boolean(n.has_children);
  const assetLike = n.kind === "asset" || isImageName(n.name) || isImageName(n.path);
  const active = current === n.path;
  const label = labelOf(n, titles);

  if (assetLike) {
    return (
      <TreeShell depth={row.depth} active={active} lead={<IconAsset />}>
        <div
          className={`tree-row ${active ? "active" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onAsset(n)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onAsset(n);
            }
          }}
        >
          <span className="tree-name">{label}</span>
        </div>
      </TreeShell>
    );
  }

  if (n.kind === "folder") {
    return (
      <TreeShell
        depth={row.depth}
        active={active}
        expanded={hasKids ? expanded : undefined}
        lead={
          <button
            type="button"
            className="tree-twist-btn"
            aria-expanded={hasKids ? expanded : undefined}
            onClick={() => onFolder(n.path, connectionId)}
            tabIndex={-1}
          >
            <IconChevron open={expanded} />
          </button>
        }
      >
        <div
          className={`tree-row ${active ? "active" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={hasKids ? expanded : undefined}
          onClick={() => onFolder(n.path, connectionId)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onFolder(n.path, connectionId);
            }
          }}
        >
          <span className="tree-name">
            {n.icon ? <span className="tree-name-emoji" aria-hidden="true">{n.icon}</span> : null}
            {label}
          </span>
        </div>
      </TreeShell>
    );
  }

  if (n.kind === "note" && n.note_id) {
    return (
      <TreeShell
        depth={row.depth}
        active={active}
        expanded={hasKids ? expanded : undefined}
        lead={
          <NoteLead
            icon={n.icon}
            hasKids={hasKids}
            expanded={expanded}
            onExpand={() => onFolder(n.path, connectionId)}
          />
        }
      >
        <Link className={`tree-row ${active ? "active" : ""}`} href={`/notes/${n.note_id}`}>
          <span className="tree-name">
            {hasKids && n.icon ? (
              <span className="tree-name-emoji" aria-hidden="true">{n.icon}</span>
            ) : null}
            {label}
          </span>
        </Link>
      </TreeShell>
    );
  }

  return (
    <TreeShell depth={row.depth} active={active} lead={<IconAsset />}>
      <div
        className={`tree-row ${active ? "active" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => onAsset(n)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onAsset(n);
          }
        }}
      >
        <span className="tree-name">{label}</span>
      </div>
    </TreeShell>
  );
});

export function TreeList({
  nodes,
  open,
  current,
  connectionId,
  titles,
  onFolder,
  onSelect,
  onAsset,
}: {
  nodes: TreeNode[];
  open: Set<string>;
  current: string;
  connectionId: string;
  titles?: Record<string, string>;
  onFolder: (path: string, connectionId: string) => void;
  onSelect: (path: string, connectionId: string) => void;
  onAsset: (node: TreeNode) => void;
}) {
  const router = useRouter();
  // Set identity changes often; key by sorted membership so flatten only reruns on real toggles.
  const openKey = useMemo(() => [...open].sort().join("\n"), [open]);
  const rows = useMemo(() => flattenVisible(nodes, open), [nodes, openKey]); // openKey tracks membership
  const currentIndex = useMemo(
    () => rows.findIndex((r) => r.node.path === current),
    [rows, current],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!rows.length) return;
      const idx = currentIndex >= 0 ? currentIndex : 0;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = rows[Math.min(rows.length - 1, idx + 1)];
        if (next) onSelect(next.node.path, connectionId);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = rows[Math.max(0, idx - 1)];
        if (prev) onSelect(prev.node.path, connectionId);
      } else if (e.key === "ArrowRight") {
        const row = rows[idx];
        if (!row) return;
        const hasKids = Boolean(row.node.children?.length) || Boolean(row.node.has_children);
        if (hasKids && !open.has(row.node.path)) {
          e.preventDefault();
          onFolder(row.node.path, connectionId);
        }
      } else if (e.key === "ArrowLeft") {
        const row = rows[idx];
        if (!row) return;
        if (open.has(row.node.path)) {
          e.preventDefault();
          onFolder(row.node.path, connectionId);
        } else if (row.depth > 0) {
          e.preventDefault();
          const parent = rows
            .slice(0, idx)
            .reverse()
            .find((r) => r.depth === row.depth - 1);
          if (parent) onSelect(parent.node.path, connectionId);
        }
      } else if (e.key === "Enter") {
        const row = rows[idx];
        if (!row) return;
        if (row.node.kind === "note" && row.node.note_id) {
          e.preventDefault();
          router.push(`/notes/${row.node.note_id}`);
        } else if (row.node.kind === "asset") {
          e.preventDefault();
          onAsset(row.node);
        } else {
          e.preventDefault();
          onFolder(row.node.path, connectionId);
        }
      }
    },
    [rows, currentIndex, connectionId, onFolder, onSelect, onAsset, open, router],
  );

  const renderRow = useCallback(
    (row: FlatRow) => (
      <TreeRow
        key={row.node.path + (row.node.asset_id ?? row.node.note_id ?? "")}
        row={row}
        current={current}
        expanded={open.has(row.node.path)}
        connectionId={connectionId}
        titles={titles}
        onFolder={onFolder}
        onAsset={onAsset}
      />
    ),
    [current, open, openKey, connectionId, titles, onFolder, onAsset],
  );

  return (
    <WindowList
      className="tree-window"
      items={rows}
      rowHeight={TREE_ROW_H}
      overscan={14}
      role="tree"
      ariaLabel="目录"
      tabIndex={0}
      onKeyDown={onKeyDown}
      scrollToIndex={currentIndex >= 0 ? currentIndex : null}
      renderRow={renderRow}
    />
  );
}

export { isImageName, isAssetsDump };
