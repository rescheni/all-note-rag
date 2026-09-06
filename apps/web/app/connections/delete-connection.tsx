"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { AnimatePresence, motion, springSoft, useReducedMotion } from "../ui-motion";
import "./connections.css";

export type DeletionFootprint = {
  notes: number;
  notes_trashed: number;
  assets: number;
  chunks: number;
  blocks: number;
  sync_runs: number;
  sync_logs: number;
  sync_running: boolean;
};

export type DeletedSummary = {
  id: string;
  name: string;
  source: string;
  notes: number;
  notes_trashed: number;
  assets: number;
  chunks: number;
};

export type DeleteTarget = { id: string; name: string; source: string };

type PreviewConnection = {
  id: string;
  name: string;
  source: string;
  status?: string;
  last_error?: string | null;
};

function statusText(status?: string): string {
  if (status === "active") return "正常";
  if (status === "error") return "错误";
  if (status === "paused") return "暂停";
  if (status === "encrypted_unreadable") return "加密不可读";
  return status || "未知";
}

export const SOURCE_LABEL: Record<string, string> = {
  obsidian: "Obsidian",
  siyuan: "思源",
  notion: "Notion",
  feishu: "飞书",
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 删除来源的确认弹层。先向 API 要一份「会被删掉什么」的清单，
 * 勾选确认后才允许删除 —— 删掉一个知识来源不该是一次误点。
 */
export function DeleteConnectionDialog({
  target,
  onCancel,
  onDeleted,
}: {
  target: DeleteTarget | null;
  onCancel: () => void;
  onDeleted: (summary: DeletedSummary, alreadyGone: boolean) => void;
}) {
  const reduced = useReducedMotion();
  const [footprint, setFootprint] = useState<DeletionFootprint | null>(null);
  const [preview, setPreview] = useState<PreviewConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [err, setErr] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = target?.id ?? "";

  useEffect(() => {
    setFootprint(null);
    setPreview(null);
    setAgreed(false);
    setErr("");
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    api<{ connection: PreviewConnection; footprint: DeletionFootprint }>(
      `/v1/connections/${id}/deletion-preview`,
    )
      .then((r) => {
        if (cancelled) return;
        setFootprint(r.footprint);
        setPreview(r.connection ?? null);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "无法读取这个来源的内容清单");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, busy, onCancel]);

  async function onConfirm() {
    if (!target) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ deleted: DeletedSummary }>(`/v1/connections/${target.id}`, { method: "DELETE" });
      onDeleted(
        {
          id: target.id,
          name: r.deleted?.name || target.name,
          source: r.deleted?.source || target.source,
          notes: num(r.deleted?.notes),
          notes_trashed: num(r.deleted?.notes_trashed),
          assets: num(r.deleted?.assets),
          chunks: num(r.deleted?.chunks),
        },
        false,
      );
    } catch (e) {
      const ex = e as Error & { code?: string };
      if (ex.code === "not_found") {
        // 已经被删掉了（另一个标签页 / 另一台设备）：当成完成，让列表刷新。
        onDeleted(
          { id: target.id, name: target.name, source: target.source, notes: 0, notes_trashed: 0, assets: 0, chunks: 0 },
          true,
        );
        return;
      }
      setErr(ex.message || "删除失败");
    } finally {
      setBusy(false);
    }
  }

  const notes = footprint ? footprint.notes : 0;
  const sourceLabel = target ? SOURCE_LABEL[target.source] ?? target.source : "";

  return (
    <AnimatePresence>
      {target && (
        <motion.div
          className="hub-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.16 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) onCancel();
          }}
        >
          <motion.div
            className="hub-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hub-del-title"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }}
            transition={reduced ? { duration: 0 } : springSoft}
          >
            <p className="hub-dialog-kicker">删除连接</p>
            <h2 id="hub-del-title">要删除「{target.name}」吗？</h2>
            <p className="hub-dialog-sub">
              {sourceLabel} 连接 · 编号 {target.id.slice(0, 8)}
            </p>
            {preview && (
              <p className="hub-dialog-who">
                当前状态：{statusText(preview.status)}
                {preview.last_error ? ` · ${preview.last_error}` : ""}
              </p>
            )}

            {loading && <p className="muted">正在统计这个来源在中枢里的内容…</p>}

            {footprint && (
              <>
                <ul className="hub-dialog-list">
                  <li>
                    <span>笔记（会从目录树、搜索与问答中消失）</span>
                    <b>{footprint.notes} 篇</b>
                  </li>
                  {footprint.notes_trashed > 0 && (
                    <li>
                      <span>已回收的旧笔记</span>
                      <b>{footprint.notes_trashed} 篇</b>
                    </li>
                  )}
                  <li>
                    <span>附件副本（含中枢里的图片）</span>
                    <b>{footprint.assets} 个</b>
                  </li>
                  <li>
                    <span>检索片段（向量索引一并清除）</span>
                    <b>{footprint.chunks} 个</b>
                  </li>
                  <li>
                    <span>同步记录与日志</span>
                    <b>
                      {footprint.sync_runs} 次 / {footprint.sync_logs} 条
                    </b>
                  </li>
                </ul>
                <p className="hub-dialog-note">
                  源里的原始内容不会被改动：中枢只读，删除只清掉中枢这一侧的副本。授权已失效也能正常删除，
                  这一步不会再去连源。
                </p>
                {footprint.sync_running && (
                  <p className="hub-dialog-warn">这个来源正在同步，删除会同时停下这次同步。</p>
                )}
                <p className="hub-dialog-warn">删除后无法撤销。想再用回来，需要重新接入并重新同步。</p>
                <label className="hub-dialog-check">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.currentTarget.checked)}
                  />
                  <span>
                    我确认删除「{target.name}」
                    {notes > 0 ? `及其 ${notes} 篇笔记` : "（当前没有笔记）"}
                  </span>
                </label>
              </>
            )}

            {err && <p className="err">{err}</p>}

            <div className="hub-dialog-actions">
              <button
                type="button"
                className="secondary"
                ref={cancelRef}
                disabled={busy}
                onClick={onCancel}
              >
                取消
              </button>
              <button
                type="button"
                className="hub-danger-solid"
                disabled={busy || loading || !footprint || !agreed}
                onClick={onConfirm}
              >
                {busy ? "删除中…" : "删除来源"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
