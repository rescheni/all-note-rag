"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";

type EventRow = {
  id: string;
  kind: string;
  happened_at: string;
  payload: { title?: string };
  note_id: string | null;
  note_title?: string | null;
  note_path?: string | null;
};

type NoteOpt = {
  id: string;
  title: string;
  path: string;
};

const KIND_LABEL: Record<string, string> = {
  goal: "目标",
  habit: "习惯",
  mood: "心情",
  review: "复盘",
  focus: "专注",
};

function shanghaiYmd(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

function lastNDayRange(days: number): { from: string; to: string } {
  const n = Math.max(1, Math.min(366, Math.floor(days) || 7));
  const to = shanghaiYmd();
  const start = new Date(Date.now() + 8 * 3600 * 1000 - (n - 1) * 24 * 3600 * 1000);
  const from = start.toISOString().slice(0, 10);
  return { from, to };
}

function parsePathFilters(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function GrowthPage() {
  const defaults = useMemo(() => lastNDayRange(7), []);
  const [space, setSpace] = useState<Space | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [notes, setNotes] = useState<NoteOpt[]>([]);
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [aiMarkdown, setAiMarkdown] = useState("");
  const [reportTab, setReportTab] = useState<"draft" | "ai">("draft");
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [includedNotes, setIncludedNotes] = useState<NoteOpt[]>([]);
  const [aiIncludeIds, setAiIncludeIds] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [recentDays, setRecentDays] = useState(7);
  const [excludePaths, setExcludePaths] = useState("垃圾桶");
  const [excludeIds, setExcludeIds] = useState<Set<string>>(new Set());
  const [noteFilter, setNoteFilter] = useState("");
  const [err, setErr] = useState("");
  const [aiErr, setAiErr] = useState("");
  const [busyDraft, setBusyDraft] = useState(false);
  const [busyAi, setBusyAi] = useState(false);

  const loadEvents = useCallback(async (id: string, rangeFrom: string, rangeTo: string) => {
    const q = new URLSearchParams();
    if (rangeFrom) q.set("from", rangeFrom);
    if (rangeTo) q.set("to", rangeTo);
    const r = await api<{ events: EventRow[] }>(`/v1/spaces/${id}/growth?${q}`);
    setEvents(r.events);
  }, []);

  const loadNotes = useCallback(async (id: string) => {
    const r = await api<{ notes: NoteOpt[] }>(`/v1/spaces/${id}/notes`);
    setNotes(r.notes ?? []);
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
        if (current.kind === "team") return;
        await Promise.all([
          loadEvents(current.id, defaults.from, defaults.to),
          loadNotes(current.id),
        ]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, [defaults.from, defaults.to, loadEvents, loadNotes]);

  function applyRecentDays(n: number) {
    const days = Math.max(1, Math.min(366, n || 7));
    setRecentDays(days);
    const range = lastNDayRange(days);
    setFrom(range.from);
    setTo(range.to);
  }

  function toggleExclude(id: string) {
    setExcludeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAiInclude(id: string) {
    setAiIncludeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllAiInclude(on: boolean) {
    if (on) setAiIncludeIds(new Set(includedNotes.map((n) => n.id)));
    else setAiIncludeIds(new Set());
  }

  async function generateDraft() {
    if (!space) return;
    setErr("");
    setAiErr("");
    setBusyDraft(true);
    try {
      const body = {
        from,
        to,
        exclude_ids: [...excludeIds],
        exclude_paths: parsePathFilters(excludePaths),
      };
      const r = await api<{
        markdown: string;
        from: string;
        to: string;
        included_notes?: NoteOpt[];
      }>(`/v1/spaces/${space.id}/growth/report`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setDraftMarkdown(r.markdown);
      setAiMarkdown("");
      setReportTab("draft");
      setReportFrom(r.from || from);
      setReportTo(r.to || to);
      const included = r.included_notes ?? [];
      setIncludedNotes(included);
      setAiIncludeIds(new Set(included.map((n) => n.id)));
      await loadEvents(space.id, from, to);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成底稿失败");
    } finally {
      setBusyDraft(false);
    }
  }

  async function generateAi() {
    if (!space || !draftMarkdown.trim()) return;
    setErr("");
    setAiErr("");
    setBusyAi(true);
    try {
      const body = {
        ai: true,
        from,
        to,
        exclude_ids: [...excludeIds],
        exclude_paths: parsePathFilters(excludePaths),
        note_ids: [...aiIncludeIds],
        draft_markdown: draftMarkdown,
      };
      const r = await api<{
        markdown: string;
        from?: string;
        to?: string;
        mode?: string;
        draft_markdown?: string;
        ai_failed?: boolean;
        ai_error?: string;
        included_notes?: NoteOpt[];
      }>(`/v1/spaces/${space.id}/growth/report`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (r.draft_markdown) setDraftMarkdown(r.draft_markdown);
      if (r.ai_failed) {
        setAiErr(r.ai_error || "AI 未能生成，已保留底稿");
        setAiMarkdown("");
        setReportTab("draft");
      } else {
        setAiMarkdown(r.markdown);
        setReportTab("ai");
      }
      if (r.from) setReportFrom(r.from);
      if (r.to) setReportTo(r.to);
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : "AI 生成失败");
    } finally {
      setBusyAi(false);
    }
  }

  const team = space?.kind === "team";
  const hasDraft = Boolean(draftMarkdown.trim());
  const displayMarkdown =
    reportTab === "ai" && aiMarkdown.trim() ? aiMarkdown : draftMarkdown;

  const noteCandidates = useMemo(() => {
    const fromEvents = events
      .filter((e) => e.note_id)
      .map((e) => ({
        id: e.note_id as string,
        title: e.payload?.title || e.note_title || e.note_id || "",
        path: e.note_path || "",
      }));
    const byId = new Map<string, NoteOpt>();
    for (const n of notes) byId.set(n.id, n);
    for (const n of fromEvents) {
      if (!byId.has(n.id)) byId.set(n.id, n);
    }
    const q = noteFilter.trim().toLowerCase();
    let list = [...byId.values()];
    if (q) {
      list = list.filter(
        (n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q),
      );
    }
    return list.slice(0, 80);
  }, [events, notes, noteFilter]);

  return (
    <>
      <h1>成长</h1>
      <p className="readonly-banner">成长分析仅用于个人空间。中枢只读，不写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {team && <p className="err">成长分析仅用于个人空间</p>}
      {err && <p className="err">{err}</p>}
      {!team && (
        <>
          <div className="card growth-report-form">
            <h2>生成报告</h2>
            <p className="hint">
              先按模板生成<strong>底稿</strong>，再勾选纳入 AI 的笔记，生成温暖可读的成长报告。默认最近 7 天（上海时区）。
            </p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="growth-from">起始日期</label>
                <input
                  id="growth-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="growth-to">结束日期</label>
                <input
                  id="growth-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="growth-days">最近 N 天</label>
                <div className="growth-days-row">
                  <input
                    id="growth-days"
                    type="number"
                    min={1}
                    max={366}
                    value={recentDays}
                    onChange={(e) => setRecentDays(Number(e.target.value) || 7)}
                  />
                  <button type="button" className="secondary" onClick={() => applyRecentDays(recentDays)}>
                    应用
                  </button>
                </div>
              </div>
              <div className="field span-2">
                <label htmlFor="growth-exclude-paths">排除笔记 / 路径</label>
                <input
                  id="growth-exclude-paths"
                  type="text"
                  placeholder="逗号分隔，如：垃圾桶,Trash"
                  value={excludePaths}
                  onChange={(e) => setExcludePaths(e.target.value)}
                />
                <p className="hint">匹配笔记 path 或 title 包含的片段；也会排除下方勾选的笔记。</p>
              </div>
              <div className="field span-2">
                <label htmlFor="growth-note-filter">勾选排除笔记</label>
                <input
                  id="growth-note-filter"
                  type="search"
                  placeholder="搜索标题或路径…"
                  value={noteFilter}
                  onChange={(e) => setNoteFilter(e.target.value)}
                />
                <p className="hint">勾选 = 从底稿与后续 AI <strong>排除</strong>。</p>
                <div className="growth-exclude-list" role="group" aria-label="排除笔记">
                  {noteCandidates.length === 0 && (
                    <p className="muted">暂无可选笔记。同步日记后会出现在这里。</p>
                  )}
                  {noteCandidates.map((n) => (
                    <label key={n.id} className="growth-exclude-item">
                      <input
                        type="checkbox"
                        checked={excludeIds.has(n.id)}
                        onChange={() => toggleExclude(n.id)}
                      />
                      <span>
                        <strong>{n.title || n.id}</strong>
                        {n.path ? <span className="muted"> · {n.path}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
                {excludeIds.size > 0 && (
                  <p className="hint">已排除 {excludeIds.size} 篇</p>
                )}
              </div>
            </div>
            <div className="form-actions">
              <button
                type="button"
                onClick={generateDraft}
                disabled={busyDraft || busyAi || !space || !from || !to}
              >
                {busyDraft ? "生成底稿中…" : "生成底稿"}
              </button>
              <span className="muted">
                范围 {from || "—"} ~ {to || "—"}
              </span>
            </div>
          </div>

          {hasDraft && (
            <div className="card growth-ai-step">
              <h2>纳入 AI 的笔记</h2>
              <p className="hint">
                底稿已生成。下方默认全选本时段<strong>未排除</strong>的笔记；取消勾选则 AI 不会使用该篇。
              </p>
              <div className="growth-ai-toolbar">
                <button
                  type="button"
                  className="secondary ask-pick-btn"
                  onClick={() => selectAllAiInclude(true)}
                  disabled={busyAi || includedNotes.length === 0}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="secondary ask-pick-btn"
                  onClick={() => selectAllAiInclude(false)}
                  disabled={busyAi || includedNotes.length === 0}
                >
                  全不选
                </button>
                <span className="muted ask-pick-count">
                  已选 {aiIncludeIds.size} / {includedNotes.length}
                </span>
              </div>
              <div className="growth-exclude-list growth-ai-include-list" role="group" aria-label="纳入 AI 的笔记">
                {includedNotes.length === 0 && (
                  <p className="muted">本时段没有可纳入的笔记（可能都被排除了）。仍可仅用底稿让 AI 润色。</p>
                )}
                {includedNotes.map((n) => (
                  <label key={n.id} className="growth-exclude-item">
                    <input
                      type="checkbox"
                      checked={aiIncludeIds.has(n.id)}
                      onChange={() => toggleAiInclude(n.id)}
                      disabled={busyAi}
                    />
                    <span>
                      <strong>{n.title || n.id}</strong>
                      {n.path ? <span className="muted"> · {n.path}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  onClick={generateAi}
                  disabled={busyAi || busyDraft || !hasDraft}
                >
                  {busyAi ? "AI 生成中…" : "AI 生成报告"}
                </button>
              </div>
              {aiErr && <p className="err">{aiErr}</p>}
            </div>
          )}

          {hasDraft && (
            <div className="card growth-report-view">
              <div className="growth-report-head">
                <h2>报告</h2>
                <div className="segmented growth-report-tabs" role="tablist" aria-label="报告视图">
                  <button
                    type="button"
                    role="tab"
                    className={reportTab === "draft" ? "active" : ""}
                    aria-selected={reportTab === "draft"}
                    onClick={() => setReportTab("draft")}
                  >
                    底稿
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={reportTab === "ai" ? "active" : ""}
                    aria-selected={reportTab === "ai"}
                    onClick={() => setReportTab("ai")}
                    disabled={!aiMarkdown.trim()}
                  >
                    AI
                  </button>
                </div>
              </div>
              <p className="muted growth-range-label">
                统计区间：{reportFrom || from} ~ {reportTo || to}
                {reportTab === "ai" && aiMarkdown.trim() ? " · AI 报告" : " · 模板底稿"}
              </p>
              <div className="report-md">
                <SafeMarkdown source={displayMarkdown} />
              </div>
            </div>
          )}

          <div className="card">
            <h2>事件</h2>
            <p className="muted">
              当前列表按 {from} ~ {to} 筛选（生成报告后会刷新）。
            </p>
            {events.length === 0 && (
              <p className="muted">还没有成长事件。同步带目标/习惯标签的日记后会出现在这里。</p>
            )}
            <ul className="list">
              {events.map((e) => (
                <li key={e.id}>
                  <strong>{KIND_LABEL[e.kind] ?? e.kind}</strong>
                  {" "}
                  {e.note_id ? (
                    <Link href={`/notes/${e.note_id}`}>{e.payload?.title || e.note_title || e.note_id}</Link>
                  ) : (
                    e.payload?.title || "手工事件"
                  )}
                  <div className="muted">{new Date(e.happened_at).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
