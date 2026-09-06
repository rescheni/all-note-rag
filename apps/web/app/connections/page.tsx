"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { isRunInProgress, SyncRunStatus, type SyncRunProgress } from "../sync-progress";
import { SignatureButton } from "../ui-motion";
import {
  DeleteConnectionDialog,
  SOURCE_LABEL,
  type DeletedSummary,
  type DeleteTarget,
} from "./delete-connection";
import "./connections.css";

type HubConnection = {
  id: string;
  name: string;
  source: string;
  status: string;
  mode?: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  created_at?: string;
  note_count?: number;
  config?: { endpoint?: string; bucket?: string; workspace_prefix?: string; kernel_base_url?: string };
  latest_run?: SyncRunProgress | null;
};

/** 左栏与文件树一致的来源顺序。 */
const SOURCE_ORDER = ["feishu", "notion", "siyuan", "obsidian"] as const;

const SOURCE_HINT: Record<string, string> = {
  obsidian: "明文 S3 前缀",
  siyuan: "内核 API 或对象存储快照",
  notion: "页面与数据库行",
  feishu: "知识库 docx",
};

function statusLabel(status: string): string {
  if (status === "active") return "正常";
  if (status === "error") return "错误";
  if (status === "paused") return "暂停";
  if (status === "encrypted_unreadable") return "加密不可读";
  return status;
}

function when(value: string | null | undefined): string {
  if (!value) return "从未";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function connMeta(c: HubConnection): string {
  const bits: string[] = [];
  if (c.config?.bucket) bits.push(c.config.bucket);
  if (c.config?.workspace_prefix) bits.push(c.config.workspace_prefix);
  if (c.config?.kernel_base_url) bits.push(c.config.kernel_base_url);
  bits.push(`最近同步 ${when(c.last_sync_at)}`);
  return bits.join(" · ");
}

export default function ConnectionsPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [conns, setConns] = useState<HubConnection[]>([]);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [renaming, setRenaming] = useState<string>("");
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const pollUntil = useRef(0);

  const fetchConns = useCallback(async (spaceId: string) => {
    const r = await api<{ connections: HubConnection[] }>(`/v1/spaces/${spaceId}/connections`);
    setConns(r.connections ?? []);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    loadSpaces()
      .then(async ({ current }) => {
        setSpace(current);
        if (current) await fetchConns(current.id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoaded(true));
  }, [fetchConns]);

  const anyRunning = conns.some((c) => isRunInProgress(c.latest_run));

  useEffect(() => {
    if (!space?.id) return;
    const spaceId = space.id;
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      api<{ connections: HubConnection[] }>(`/v1/spaces/${spaceId}/connections`)
        .then((r) => {
          if (cancelled) return;
          setConns(r.connections ?? []);
          const running = (r.connections ?? []).some((x) => isRunInProgress(x.latest_run));
          timer = window.setTimeout(tick, running || Date.now() < pollUntil.current ? 2000 : 8000);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(tick, 8000);
        });
    };
    timer = window.setTimeout(tick, anyRunning || Date.now() < pollUntil.current ? 2000 : 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [space?.id, anyRunning]);

  const canManage = space?.role === "owner" || space?.role === "editor";

  async function triggerSync(id: string) {
    setErr("");
    setBusyId(id);
    try {
      await api(`/v1/connections/${id}/sync`, { method: "POST" });
      pollUntil.current = Date.now() + 120000;
      if (space) await fetchConns(space.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "同步失败");
    } finally {
      setBusyId("");
    }
  }

  async function saveRename(id: string) {
    const name = renameValue.trim();
    if (!name) return;
    setErr("");
    setBusyId(id);
    try {
      await api(`/v1/connections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setRenaming("");
      if (space) await fetchConns(space.id);
      setFlash(`已改名为「${name}」。`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "改名失败");
    } finally {
      setBusyId("");
    }
  }

  async function onDeleted(summary: DeletedSummary, alreadyGone: boolean) {
    setTarget(null);
    setConns((list) => list.filter((c) => c.id !== summary.id));
    setFlash(
      alreadyGone
        ? `「${summary.name}」已不在中枢，列表已刷新。`
        : `已删除「${summary.name}」：移除 ${summary.notes} 篇笔记、${summary.assets} 个附件、${summary.chunks} 个检索片段。`,
    );
    if (space) {
      try {
        await fetchConns(space.id);
      } catch {
        /* 轮询会补上 */
      }
    }
  }

  const groups = SOURCE_ORDER.map((source) => ({
    source,
    items: conns.filter((c) => c.source === source),
  })).filter((g) => g.items.length > 0);
  const others = conns.filter((c) => !(SOURCE_ORDER as readonly string[]).includes(c.source));
  if (others.length) groups.push({ source: others[0].source as (typeof SOURCE_ORDER)[number], items: others });

  const countBySource = (source: string) => conns.filter((c) => c.source === source).length;

  return (
    <div className="hub-sources">
      <h1>来源</h1>
      <p className="hub-lede">
        中枢只读，不写回任何源。同一个源可以接入多个连接（Notion、思源、Obsidian、飞书都一样），删除只清掉中枢这一侧的副本。
      </p>

      {space && (
        <p className="muted">
          当前空间：{space.name}（{spaceKindLabel(space.kind)}）
        </p>
      )}
      {err && <p className="err">{err}</p>}
      {flash && (
        <p className="hub-flash">
          <span>{flash}</span>
        </p>
      )}

      {canManage && (
        <section className="hub-add">
          <h2>接入新来源</h2>
          <div className="hub-add-grid">
            {SOURCE_ORDER.map((s) => (
              <Link key={s} className="hub-add-card" href={`/connections/new?source=${s}`}>
                <strong>{SOURCE_LABEL[s]}</strong>
                <span>
                  {SOURCE_HINT[s]}
                  {countBySource(s) > 0 ? ` · 已有 ${countBySource(s)} 个` : ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {!canManage && space && (
        <p className="muted">你是只读成员，可以查看来源，但不能新增、改名或删除。</p>
      )}

      {loaded && conns.length === 0 && (
        <div className="hub-empty">还没有接入任何来源。从上面选一个源开始，同步完成后笔记会出现在「笔记」里。</div>
      )}

      {groups.map((g) => {
        const notes = g.items.reduce((sum, c) => sum + Number(c.note_count ?? 0), 0);
        const nameCounts = new Map<string, number>();
        for (const c of g.items) {
          const key = c.name.trim();
          nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
        }
        return (
          <section className="hub-group" key={g.source}>
            <div className="hub-group-head">
              <div className="hub-group-title">
                <h2>{SOURCE_LABEL[g.source] ?? g.source}</h2>
                <span className="hub-group-count">
                  {g.items.length} 个连接 · {notes} 篇笔记
                </span>
              </div>
              {canManage && (
                <Link className="hub-group-add" href={`/connections/new?source=${g.source}`}>
                  再接入一个{SOURCE_LABEL[g.source] ?? g.source} →
                </Link>
              )}
            </div>

            <div className="hub-tiles">
              {g.items.map((c) => {
                const dup = (nameCounts.get(c.name.trim()) ?? 0) > 1;
                const running = isRunInProgress(c.latest_run);
                return (
                  <article className="hub-tile" key={c.id}>
                    <div className="hub-tile-head">
                      {renaming === c.id ? (
                        <div className="hub-rename">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveRename(c.id);
                              if (e.key === "Escape") setRenaming("");
                            }}
                            aria-label="连接名称"
                          />
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyId === c.id || !renameValue.trim()}
                            onClick={() => void saveRename(c.id)}
                          >
                            保存
                          </button>
                          <button type="button" className="linkish" onClick={() => setRenaming("")}>
                            取消
                          </button>
                        </div>
                      ) : (
                        <>
                          <span className="hub-tile-name" title={c.name}>
                            {c.name}
                          </span>
                          <span
                            className={`status-pill ${running ? "status-syncing" : `status-${c.status}`}`}
                          >
                            {running ? "同步中" : statusLabel(c.status)}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="hub-tile-stat">
                      <b>{Number(c.note_count ?? 0)}</b>
                      <span>篇笔记在中枢</span>
                    </div>
                    <div className="hub-tile-meta">{connMeta(c)}</div>
                    <div className="hub-tile-meta">
                      接入于 {when(c.created_at)} · 编号 {c.id.slice(0, 8)}
                    </div>
                    {dup && (
                      <p className="hub-tile-hint">
                        同来源里有同名连接，改个名字更好区分（例如「飞书 · 工作」）。
                      </p>
                    )}
                    <SyncRunStatus run={c.latest_run} />
                    {c.last_error && <div className="hub-tile-err">{c.last_error}</div>}

                    {canManage && (
                      <div className="hub-tile-actions">
                        <Link href={`/connections/${c.id}`} className="btn secondary">
                          编辑
                        </Link>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busyId === c.id}
                          onClick={() => void triggerSync(c.id)}
                        >
                          立即同步
                        </button>
                        {renaming !== c.id && (
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => {
                              setRenameValue(c.name);
                              setRenaming(c.id);
                            }}
                          >
                            改名
                          </button>
                        )}
                        <button
                          type="button"
                          className="hub-danger"
                          onClick={() => {
                            setFlash("");
                            setTarget({ id: c.id, name: c.name, source: c.source });
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="form-actions">
        <SignatureButton type="button" onClick={() => (location.href = "/notes")}>
          去看笔记
        </SignatureButton>
        <Link href="/" className="btn secondary">
          返回空间
        </Link>
      </div>

      <DeleteConnectionDialog target={target} onCancel={() => setTarget(null)} onDeleted={onDeleted} />
    </div>
  );
}
