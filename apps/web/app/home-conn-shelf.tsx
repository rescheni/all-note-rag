"use client";

import {
  type CSSProperties,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  isRunInProgress,
  SyncRunStatus,
  type SyncRunProgress,
} from "./sync-progress";

export type HomeConn = {
  id: string;
  name: string;
  source: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  note_count?: number;
  latest_run?: SyncRunProgress | null;
};

const SOURCE_LABEL: Record<string, string> = {
  feishu: "飞书",
  notion: "Notion",
  siyuan: "思源",
  obsidian: "Obsidian",
};

const SOURCE_ORDER = ["feishu", "notion", "siyuan", "obsidian"] as const;
const VOLUME_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] || source || "源";
}

function spineDepth(count: number | undefined): number {
  if (count === undefined) return 26;
  if (count <= 0) return 12;
  return Math.min(46, Math.round(16 + Math.log2(count + 1) * 5.2));
}

function countLabel(count: number | undefined): string {
  if (count === undefined) return "清点中…";
  if (count <= 0) return "还没有笔记";
  return `${count} 篇`;
}

function syncRelative(value: string | null | undefined): string {
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

function statusLabel(status: string) {
  if (status === "active") return "正常";
  if (status === "error") return "错误";
  if (status === "paused") return "暂停";
  if (status === "encrypted_unreadable") return "加密不可读";
  return status;
}

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

function orderConns(conns: HomeConn[]): { conn: HomeConn; volume: number }[] {
  const bySource = new Map<string, HomeConn[]>();
  for (const c of conns) {
    const k = c.source || "_";
    const arr = bySource.get(k);
    if (arr) arr.push(c);
    else bySource.set(k, [c]);
  }
  const keys = [...bySource.keys()].sort((a, b) => {
    const ia = (SOURCE_ORDER as readonly string[]).indexOf(a);
    const ib = (SOURCE_ORDER as readonly string[]).indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b, "zh");
  });
  const out: { conn: HomeConn; volume: number }[] = [];
  for (const source of keys) {
    const items = bySource.get(source)!;
    const multi = items.length > 1;
    items.forEach((conn, i) => {
      out.push({ conn, volume: multi ? i + 1 : 0 });
    });
  }
  return out;
}

function ConnBook({
  conn,
  volume,
  index,
  canSync,
  onSync,
}: {
  conn: HomeConn;
  volume: number;
  index: number;
  canSync: boolean;
  onSync: (id: string) => void;
}) {
  const router = useRouter();
  const empty = (conn.note_count ?? 0) <= 0;
  const depth = spineDepth(conn.note_count);
  const label = countLabel(conn.note_count);
  const volumeMark = volume > 0 ? `卷${VOLUME_CN[volume] ?? volume}` : "";
  const syncing = isRunInProgress(conn.latest_run);

  function openBook() {
    router.push(`/notes?book=${encodeURIComponent(conn.id)}`);
  }

  function syncClick(e: MouseEvent) {
    e.stopPropagation();
    onSync(conn.id);
  }

  return (
    <div className="shelf-slot home-shelf-slot" style={{ "--slot-i": index } as CSSProperties}>
      <button
        type="button"
        className={`source-book${empty ? " is-empty" : ""}`}
        data-source={conn.source}
        style={
          {
            "--spine-depth": `${depth}px`,
            "--cover-shade": `rgba(60, 51, 44, ${Math.max(0, volume - 1) * 0.1})`,
          } as CSSProperties
        }
        onClick={openBook}
        aria-label={`打开${sourceLabel(conn.source)}｜${conn.name}${volumeMark ? ` ${volumeMark}` : ""}，${label}`}
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
              {sourceLabel(conn.source)}
              {volumeMark ? <em>{volumeMark}</em> : null}
            </span>
          </span>
          <span className="book-cover">
            <span className="book-cover-face">
              <span className="book-cover-top">
                <SourceMark source={conn.source} />
                <span className="book-cover-source">{sourceLabel(conn.source)}</span>
                {volumeMark ? <span className="book-cover-volume">{volumeMark}</span> : null}
              </span>
              <span className="book-cover-title">{conn.name}</span>
              <span className="book-cover-foot">
                <span className="book-cover-count">{label}</span>
                <span className="book-cover-sync">{syncRelative(conn.last_sync_at)}</span>
              </span>
            </span>
            <span className="book-cover-inside">
              <span className="book-cover-inside-plate">{sourceLabel(conn.source)}</span>
            </span>
          </span>
        </span>
        <span className="book-shade" aria-hidden="true" />
      </button>
      <div className="home-book-meta">
        {syncing ? (
          <SyncRunStatus run={conn.latest_run} />
        ) : (
          <button
            type="button"
            className={`home-book-status${conn.status === "error" ? " is-error" : ""}`}
            onClick={canSync ? syncClick : openBook}
            title={canSync ? "点击同步" : undefined}
          >
            {statusLabel(conn.status)}
            {conn.last_sync_at ? ` · ${syncRelative(conn.last_sync_at)}` : null}
          </button>
        )}
        {!syncing && <SyncRunStatus run={conn.latest_run} />}
        {conn.last_error && !syncing && <div className="err home-book-err">{conn.last_error}</div>}
        {canSync && (
          <button type="button" className="linkish home-book-sync-btn" onClick={syncClick}>
            同步
          </button>
        )}
      </div>
    </div>
  );
}

export function HomeConnShelf({
  conns,
  canSync,
  onSync,
}: {
  conns: HomeConn[];
  canSync: boolean;
  onSync: (id: string) => void;
}) {
  const shelf = orderConns(conns);
  if (!shelf.length) return null;
  return (
    <div className="home-conn-shelf stage-shelf">
      <div className="bookshelf">
        {shelf.map(({ conn, volume }, i) => (
          <ConnBook
            key={conn.id}
            conn={conn}
            volume={volume}
            index={i}
            canSync={canSync}
            onSync={onSync}
          />
        ))}
      </div>
    </div>
  );
}
