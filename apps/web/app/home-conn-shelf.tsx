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
import { IconSourceMark, IconSync } from "./icons";

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
                <span className="book-cover-source-pill">
                  <IconSourceMark source={conn.source} />
                  <span className="book-cover-source">{sourceLabel(conn.source)}</span>
                </span>
                {volumeMark ? <span className="book-cover-volume">{volumeMark}</span> : null}
              </span>
              <span className="book-cover-title">{conn.name}</span>
              <span className="book-cover-foot">
                <span className="book-cover-count">{label}</span>
                <span className="book-cover-sync">
                  <IconSync className="sync-glyph" />
                  {syncRelative(conn.last_sync_at)}
                </span>
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
            <IconSync spinning={syncing} className="sync-glyph" />
            <span>
              {statusLabel(conn.status)}
              {conn.last_sync_at ? ` · ${syncRelative(conn.last_sync_at)}` : null}
            </span>
          </button>
        )}
        {!syncing && <SyncRunStatus run={conn.latest_run} />}
        {conn.last_error && !syncing && <div className="err home-book-err">{conn.last_error}</div>}
        {canSync && (
          <button type="button" className="linkish home-book-sync-btn" onClick={syncClick}>
            <IconSync className="sync-glyph" />
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
