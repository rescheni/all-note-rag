"use client";
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";
import { CiteActiveProvider, useCiteActive } from "@/lib/cite-marks";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";
import { IconAsk, IconClose } from "../icons";
import {
  AnimatePresence,
  SignatureButton,
  easeOutExpo,
  motion,
  springSoft,
  springSnap,
  springPop,
  useReducedMotion,
} from "../ui-motion";

type Citation = {
  note_id: string;
  block_id: string;
  source_block_id: string;
  title: string;
  quote: string;
  preview_url: string;
  path?: string;
  connection_id?: string;
};

type AskOut = {
  answer_markdown: string;
  citations: Citation[];
  unknown?: boolean;
  mode?: "ai" | "extractive" | "retrieve";
  ai_configured?: boolean;
  ai_failed?: boolean;
  ai_error?: string;
  thread_id?: string;
  retrieve_only?: boolean;
};

type Thread = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[] | null;
  mode?: string | null;
  ai_failed?: boolean | null;
  ai_error?: string | null;
  created_at: string;
};

/** In-flight reveal: retrieve scan → pick notes → generate answer. */
type RevealState = {
  id: string;
  /** Full citation list for 【n】 marks in the answer. */
  citations: Citation[];
  /** Filtered/numbered cards for the retrieve animation. */
  displayCitations: DisplayCitation[];
  answer: string;
  /** User question that produced this reveal */
  query?: string;
  mode?: string | null;
  ai_failed?: boolean;
  ai_error?: string | null;
  phase: "retrieve" | "pick" | "answer";
  activeIndex: number;
  /** note_id → include in generate (default all true after retrieve). */
  selectedNoteIds: Record<string, boolean>;
  pendingQuery?: string;
  optimisticUserId?: string;
};

const ASK_TIMEOUT_MS = 180_000;
const SOURCES_OPEN_KEY = "note-hub:ask-sources-open";
const RETRIEVE_STEP_MS = 680;
const FOLD_HOLD_MS = 720;
const PIPELINE_STAGES = [
  { id: "parse", label: "解析问题 / 提取关键词" },
  { id: "index", label: "检索笔记索引" },
  { id: "match", label: "对照相关片段" },
  { id: "answer", label: "生成回答" },
] as const;
const PIPELINE_STEP_MS = 1400;

function shelfHref(c: Citation): string | null {
  if (!c.connection_id || !c.path) return null;
  const parts = c.path.split("/").filter(Boolean);
  const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const q = new URLSearchParams({ book: c.connection_id });
  if (parent) q.set("path", parent);
  return `/notes?${q.toString()}`;
}

function citeHref(c: Citation): string {
  return (
    c.preview_url ||
    `/notes/${c.note_id}${c.source_block_id ? `#b-${c.source_block_id}` : ""}`
  );
}

function normalizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Citation => Boolean(c) && typeof c === "object");
}

/** Usable source card: real quote, not empty/garbled. */
function isUsableCitation(c: Citation): boolean {
  const quote = (c.quote || "").replace(/\s+/g, " ").trim();
  if (quote.length < 8) return false;
  const meaningful = quote
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  if (meaningful.length < 4) return false;
  return Boolean(c.note_id);
}

type DisplayCitation = Citation & { n: number };

/**
 * Show ALL usable retrieved sources (not only those named in 【n】).
 * Cited ones sort first so scan highlights answer-backed notes early.
 * `n` keeps the original 1-based index for hover marks.
 */
function selectDisplayCitations(
  citations: Citation[],
  answer?: string | null,
): DisplayCitation[] {
  const indexed = citations
    .map((c, i) => ({ ...c, n: i + 1 }))
    .filter((c) => isUsableCitation(c));
  if (!indexed.length) return [];
  if (!answer) return indexed;
  const refs = new Set<number>();
  for (const m of answer.matchAll(/【(\d+)】/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= citations.length) refs.add(n);
  }
  if (!refs.size) return indexed;
  const cited = indexed.filter((c) => refs.has(c.n));
  const rest = indexed.filter((c) => !refs.has(c.n));
  return [...cited, ...rest];
}


/** Lightweight client check: few usable cites or thin CJK/Latin overlap with the question. */

function searchHitsToCitations(
  results: Array<{
    note_id?: string;
    title?: string;
    snippet?: string | null;
    path?: string;
    connection_id?: string;
    source_block_id?: string | null;
    preview_url?: string;
  }>,
): Citation[] {
  const out: Citation[] = [];
  for (const r of results) {
    if (!r?.note_id) continue;
    // Skip obvious asset noise in early scan
    const title = (r.title || "").trim();
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(title)) continue;
    const c: Citation = {
      note_id: r.note_id,
      block_id: r.source_block_id || "",
      source_block_id: r.source_block_id || "",
      title,
      quote: String(r.snippet || "").replace(/\s+/g, " ").trim().slice(0, 220),
      preview_url: r.preview_url || `/notes/${r.note_id}`,
      path: r.path || "",
      connection_id: r.connection_id || "",
    };
    if (isUsableCitation(c)) out.push(c);
    if (out.length >= 12) break;
  }
  return out;
}

function isWeakEvidence(query: string | null | undefined, citations: DisplayCitation[]): boolean {
  if (!citations.length) return true;
  const q = (query || "").trim();
  if (!q) return citations.length <= 1;
  const qChars = new Set(
    q
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .split("")
      .filter((ch) => /[\u3400-\u9fffA-Za-z0-9]/.test(ch)),
  );
  if (!qChars.size) return citations.length <= 1;
  let best = 0;
  for (const c of citations) {
    const blob = `${c.title || ""} ${c.quote || ""}`.toLowerCase();
    let hit = 0;
    for (const ch of qChars) if (blob.includes(ch)) hit++;
    best = Math.max(best, hit / qChars.size);
  }
  return best < 0.28 || citations.length <= 1;
}

function AskRetrievePipeline({
  reduced,
  mode = "generate",
}: {
  reduced: boolean | null;
  /** retrieve: stop at 对照相关片段; generate: include 生成回答 */
  mode?: "retrieve" | "generate";
}) {
  const stages =
    mode === "retrieve"
      ? PIPELINE_STAGES.filter((s) => s.id !== "answer")
      : PIPELINE_STAGES;
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (reduced) {
      setStage(stages.length - 1);
      return;
    }
    setStage(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i < stages.length; i++) {
      timers.push(setTimeout(() => setStage(i), PIPELINE_STEP_MS * i));
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [reduced, mode, stages.length]);

  return (
    <div className="ask-pipeline" aria-busy="true" aria-live="polite">
      <p className="ask-pipeline-kicker">{mode === "retrieve" ? "检索过程" : "生成过程"}</p>
      <ol className="ask-pipeline-steps">
        {stages.map((s, i) => {
          const state = i < stage ? "done" : i === stage ? "active" : "pending";
          return (
            <li key={s.id} className={`ask-pipeline-step ask-pipeline-step-${state}`} data-state={state}>
              <span className="ask-pipeline-dot" aria-hidden="true" />
              <span className="ask-pipeline-label">{s.label}</span>
              {state === "active" ? <span className="ask-pipeline-pulse" aria-hidden="true" /> : null}
              {state === "done" ? <span className="ask-pipeline-check" aria-hidden="true">✓</span> : null}
            </li>
          );
        })}
      </ol>
      <p className="ask-pipeline-hint muted">{stages[Math.min(stage, stages.length - 1)].label}…</p>
    </div>
  );
}

function useSourcesOpenPref(): [boolean, (v: boolean) => void] {
  // Always start collapsed (history + post-scan). Ignore stale localStorage open=1.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(SOURCES_OPEN_KEY, "0");
    } catch {
      /* ignore */
    }
  }, []);
  const set = useCallback((v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(SOURCES_OPEN_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  return [open, set];
}

function CitationsBlock({
  citations,
  reduced,
  scanning,
  activeIndex,
  forceOpen,
  query,
  picking,
  selectedNoteIds,
  onToggleNote,
  onSelectAll,
  onSelectNone,
  onConfirmGenerate,
  onCancelPick,
  generateDisabled,
  pickLocked,
}: {
  citations: DisplayCitation[];
  reduced: boolean | null;
  /** Step-through retrieve animation */
  scanning?: boolean;
  activeIndex?: number;
  /** While scanning / picking, keep body open */
  forceOpen?: boolean;
  /** Original question — for weak-evidence hint */
  query?: string | null;
  picking?: boolean;
  selectedNoteIds?: Record<string, boolean>;
  onToggleNote?: (noteId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  onConfirmGenerate?: () => void;
  onCancelPick?: () => void;
  generateDisabled?: boolean;
  /** True while generate request in flight */
  pickLocked?: boolean;
}) {
  const [prefOpen, setPrefOpen] = useSourcesOpenPref();
  const wasScanning = useRef(false);
  // Never auto-open on cite hover / activeN — only scan/pick forceOpen or user pref.
  const open = forceOpen || scanning || picking ? true : prefOpen;
  const panelId = useId();
  const { activeN } = useCiteActive();
  const cardRefs = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    // Fold only after leaving scan into answer — not when entering pick.
    if (wasScanning.current && !scanning && !picking) {
      setPrefOpen(false);
    }
    wasScanning.current = Boolean(scanning);
  }, [scanning, picking, setPrefOpen]);

  // Only scroll when the accordion is already open — never while collapsed
  // (scrollIntoView on collapsed/hidden cards reflows and feeds hover flicker).
  useEffect(() => {
    if (activeN == null || scanning || !open) return;
    const el = cardRefs.current.get(activeN);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeN, scanning, open]);

  if (!citations.length) {
    if (picking) {
      return (
        <div className="ask-cites">
          <p className="hub-inline-empty muted">这次没有可点的来源卡片。</p>
          <div className="ask-pick-bar" role="group" aria-label="选择笔记">
            <p className="ask-pick-hint muted">没有可纳入的笔记，可取消后换个问法</p>
            <div className="ask-pick-actions">
              <button
                type="button"
                className="ask-pick-btn secondary"
                disabled={pickLocked}
                onClick={onCancelPick}
              >
                取消
              </button>
              <SignatureButton type="button" disabled>
                用所选笔记生成
              </SignatureButton>
            </div>
          </div>
        </div>
      );
    }
    return <p className="hub-inline-empty muted">这次没有可点的来源卡片。</p>;
  }

  const visible = scanning
    ? citations.slice(0, Math.max(0, (activeIndex ?? 0) + 1))
    : citations;

  // Hover quote lives in the fixed portal popover on 【n】 marks.
  // Chip highlight only — never expand an in-flow strip (that pushes the answer).
  const weak = !scanning && isWeakEvidence(query, citations);

  return (
    <div className={`ask-cites${scanning ? " ask-cites-scanning" : ""}`}>
      <div className="cite-chip-row" aria-label="来源速览">
        <AnimatePresence initial={false}>
          {visible.map((c, i) => {
            const active =
              (scanning && i === activeIndex) ||
              (!scanning && activeN === c.n);
            return (
              <motion.div
                key={`chip-${c.n}-${c.note_id}-${c.source_block_id || c.block_id}`}
                layout
                initial={scanning && !reduced ? { opacity: 0, y: 14, scale: 0.88 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, scale: 0.96 }}
                transition={scanning ? springPop : springSnap}
                whileHover={reduced ? undefined : { y: -1, scale: 1.02 }}
                whileTap={reduced ? undefined : { scale: 0.97 }}
              >
                <Link
                  href={citeHref(c)}
                  className={`cite-chip${active ? " cite-chip-active" : ""}`}
                >
                  <span className="cite-chip-n" aria-hidden="true">
                    {c.n}
                  </span>
                  <span className="cite-chip-t">{decodeSegment(c.title) || "未命名"}</span>
                </Link>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {weak ? (
        <p className="ask-weak-pill" role="status">
          依据较弱 · 笔记重合不多，回答请对照原文斟酌
        </p>
      ) : null}

      <div className="ask-cites-toggle-row">
        <button
          type="button"
          className="ask-cites-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={Boolean(forceOpen || scanning || picking)}
          onClick={() => setPrefOpen(!prefOpen)}
        >
          <span className="ask-cites-chevron" aria-hidden="true" data-open={open ? "1" : "0"} />
          <span className="ask-cites-h">来源</span>
          <span className="ask-cites-count muted">{citations.length}</span>
          {scanning ? (
            <span className="ask-retrieve-live muted" aria-live="polite">
              找到 {(activeIndex ?? 0) + 1} / {citations.length} · 正在往下搜寻…
            </span>
          ) : picking ? (
            <span className="ask-retrieve-live muted" aria-live="polite">
              勾选要纳入的笔记，排除无关后再生成
            </span>
          ) : (
            <span className="ask-cites-hint muted">{open ? "收起" : "展开"}</span>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            className="cite-stack-wrap"
            key="stack"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.55, ease: easeOutExpo }}
            style={{ overflow: "hidden" }}
          >
            <div className="cite-stack">
              <AnimatePresence initial={false}>
                {visible.map((c, i) => {
                  const shelf = shelfHref(c);
                  const active =
                    (scanning && i === activeIndex) ||
                    (!scanning && !picking && activeN === c.n);
                  const checked = Boolean(selectedNoteIds?.[c.note_id] ?? true);
                  const muted = Boolean(picking && !checked);
                  return (
                    <motion.article
                      key={`card-${c.n}-${c.note_id}-${c.source_block_id || c.block_id}`}
                      layout
                      ref={(node) => {
                        if (node) cardRefs.current.set(c.n, node);
                        else cardRefs.current.delete(c.n);
                      }}
                      className={`cite-card${active ? " cite-card-active" : ""}${muted ? " cite-card-excluded" : ""}`}
                      initial={
                        scanning && !reduced
                          ? { opacity: 0, y: 22, scale: 0.9 }
                          : reduced
                            ? false
                            : { opacity: 0, y: 8 }
                      }
                      animate={{ opacity: muted ? 0.55 : 1, y: 0, scale: 1 }}
                      exit={reduced ? undefined : { opacity: 0, y: -4, scale: 0.98 }}
                      transition={
                        scanning
                          ? springPop
                          : { duration: reduced ? 0 : 0.38, ease: easeOutExpo }
                      }
                      whileHover={reduced || scanning || picking ? undefined : { y: -1 }}
                    >
                      {picking ? (
                        <label className="cite-card-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={pickLocked}
                            aria-label={`纳入「${decodeSegment(c.title) || "未命名"}」`}
                            onChange={() => onToggleNote?.(c.note_id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </label>
                      ) : null}
                      <Link
                        href={citeHref(c)}
                        className="cite-card-main"
                        onClick={(e) => {
                          if (picking) e.preventDefault();
                        }}
                        tabIndex={picking ? -1 : undefined}
                      >
                        <div className="cite-card-head">
                          <span className="cite-chip-n" aria-hidden="true">
                            {c.n}
                          </span>
                          <h3>{decodeSegment(c.title) || "未命名"}</h3>
                        </div>
                        {c.path ? <PathCrumbs path={c.path} title={c.title} /> : null}
                        {c.quote ? <blockquote className="ask-quote">{c.quote}</blockquote> : null}
                      </Link>
                      {shelf && !picking ? (
                        <div className="cite-card-foot">
                          <Link href={shelf} className="hit-shelf">
                            在书架中打开
                          </Link>
                        </div>
                      ) : null}
                    </motion.article>
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {picking ? (
        <div className="ask-pick-bar" role="group" aria-label="选择笔记">
          <p className="ask-pick-hint muted">勾选要纳入的笔记，排除无关后再生成</p>
          <div className="ask-pick-actions">
            <button
              type="button"
              className="ask-pick-btn secondary"
              disabled={pickLocked}
              onClick={onSelectAll}
            >
              全选
            </button>
            <button
              type="button"
              className="ask-pick-btn secondary"
              disabled={pickLocked}
              onClick={onSelectNone}
            >
              全不选
            </button>
            <span className="ask-pick-count muted">
              已选{" "}
              {new Set(
                citations.filter((c) => selectedNoteIds?.[c.note_id] !== false).map((c) => c.note_id),
              ).size}{" "}
              / {new Set(citations.map((c) => c.note_id)).size}
            </span>
            <button
              type="button"
              className="ask-pick-btn secondary"
              disabled={pickLocked}
              onClick={onCancelPick}
            >
              取消
            </button>
            <SignatureButton
              type="button"
              disabled={Boolean(generateDisabled || pickLocked)}
              onClick={onConfirmGenerate}
            >
              {pickLocked ? "生成中…" : "用所选笔记生成"}
            </SignatureButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AssistantBody({
  content,
  citations,
  displayCitations,
  mode,
  aiFailed,
  aiError,
  reduced,
  scanning,
  activeIndex,
  query,
  picking,
  selectedNoteIds,
  onToggleNote,
  onSelectAll,
  onSelectNone,
  onConfirmGenerate,
  onCancelPick,
  generateDisabled,
  pickLocked,
}: {
  content: string | null;
  citations: Citation[];
  /** Precomputed scan/display cards; falls back to selectDisplayCitations. */
  displayCitations?: DisplayCitation[];
  mode?: string | null;
  aiFailed?: boolean;
  aiError?: string | null;
  reduced: boolean | null;
  scanning?: boolean;
  activeIndex?: number;
  /** Paired user question for weak-evidence hint */
  query?: string | null;
  picking?: boolean;
  selectedNoteIds?: Record<string, boolean>;
  onToggleNote?: (noteId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  onConfirmGenerate?: () => void;
  onCancelPick?: () => void;
  generateDisabled?: boolean;
  pickLocked?: boolean;
}) {
  const displayCites =
    displayCitations ?? selectDisplayCitations(citations, content);
  return (
    <CiteActiveProvider>
      <div className="ask-assistant-stack">
        {/* 检索永远在上：不要把「回答来自…」放在来源前面，否则看起来像来源在下面 */}
        {scanning ? (
          <p className="ask-mode-pill muted" aria-live="polite">
            正在搜寻相关笔记…
          </p>
        ) : picking ? (
          <p className="ask-mode-pill muted" aria-live="polite">
            请勾选要纳入回答的笔记
          </p>
        ) : null}

        {displayCites.length || picking ? (
          <section className="ask-section ask-section-cites" aria-label="检索来源">
            <p className="ask-section-label">检索</p>
            <CitationsBlock
              citations={displayCites}
              reduced={reduced}
              scanning={scanning}
              activeIndex={activeIndex}
              forceOpen={Boolean(scanning || picking)}
              query={query}
              picking={picking}
              selectedNoteIds={selectedNoteIds}
              onToggleNote={onToggleNote}
              onSelectAll={onSelectAll}
              onSelectNone={onSelectNone}
              onConfirmGenerate={onConfirmGenerate}
              onCancelPick={onCancelPick}
              generateDisabled={generateDisabled}
              pickLocked={pickLocked}
            />
          </section>
        ) : !scanning && content != null ? (
          <p className="hub-inline-empty muted ask-section-cites">笔记里没有直接依据可点的来源。</p>
        ) : null}

        {content != null && !scanning && !picking ? (
          <section className="ask-section ask-section-answer" aria-label="回答">
            <p className="ask-section-label">回答</p>
            {aiFailed ? (
              <p className="ask-ai-failed" role="status">
                {`AI 未能生成（${aiError || "未知原因"}）. 以下为检索摘录。`}
              </p>
            ) : mode ? (
              <p className="ask-mode-pill muted">
                {mode === "ai" ? "回答来自大模型（附引用）" : "回答为本地抽取（未走大模型）"}
              </p>
            ) : null}
            <motion.article
              className="ask-answer-paper"
              initial={reduced ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0 : 0.45, ease: easeOutExpo, delay: reduced ? 0 : 0.06 }}
            >
              <SafeMarkdown source={content} citations={citations} />
            </motion.article>
          </section>
        ) : null}
      </div>
    </CiteActiveProvider>
  );
}

export default function AskPage() {
  const reduced = useReducedMotion();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const didAutoOpen = useRef(false);
  const [space, setSpace] = useState<Space | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [aiReady, setAiReady] = useState(true);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearRevealTimers = useCallback(() => {
    for (const t of revealTimers.current) clearTimeout(t);
    revealTimers.current = [];
  }, []);

  useEffect(() => () => clearRevealTimers(), [clearRevealTimers]);

  const loadMessages = useCallback(
    async (spaceId: string, tid: string, opts?: { silent?: boolean }) => {
      if (!opts?.silent) {
        setLoadingMessages(true);
        setErr("");
      }
      try {
        const r = await api<{ messages: ChatMessage[] }>(
          `/v1/spaces/${spaceId}/ask/threads/${tid}/messages`,
        );
        setMessages(
          (r.messages ?? []).map((m) => ({
            ...m,
            citations: normalizeCitations(m.citations),
          })),
        );
      } catch (e) {
        if (!opts?.silent) {
          setErr(e instanceof Error ? e.message : "加载消息失败");
          setMessages([]);
        }
      } finally {
        if (!opts?.silent) setLoadingMessages(false);
      }
    },
    [],
  );

  const refreshThreads = useCallback(
    async (spaceId: string, opts?: { openLatest?: boolean }) => {
      setLoadingThreads(true);
      try {
        const r = await api<{ threads: Thread[] }>(`/v1/spaces/${spaceId}/ask/threads`);
        const list = r.threads ?? [];
        setThreads(list);
        if (opts?.openLatest && list[0]) {
          didAutoOpen.current = true;
          setThreadId(list[0].id);
          await loadMessages(spaceId, list[0].id);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载对话失败");
      } finally {
        setLoadingThreads(false);
      }
    },
    [loadMessages],
  );

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    didAutoOpen.current = false;
    loadSpaces()
      .then(({ current }) => {
        setSpace(current);
        if (current) void refreshThreads(current.id, { openLatest: true });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
    api<{ configured?: boolean }>("/v1/settings/ai")
      .then((s) => setAiReady(Boolean(s.configured)))
      .catch(() => setAiReady(false));
  }, [refreshThreads]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, reveal]);

  function startNewChat() {
    clearRevealTimers();
    setReveal(null);
    setThreadId(null);
    setMessages([]);
    setErr("");
    inputRef.current?.focus();
  }

  async function selectThread(tid: string) {
    if (!space || tid === threadId) return;
    clearRevealTimers();
    setReveal(null);
    setThreadId(tid);
    setErr("");
    await loadMessages(space.id, tid);
  }

  function requestDeleteThread(tid: string) {
    const title = threads.find((t) => t.id === tid)?.title?.trim() || "此对话";
    setDeleteTarget({ id: tid, title });
  }

  async function confirmDeleteThread() {
    if (!space || !deleteTarget) return;
    const tid = deleteTarget.id;
    setDeleting(true);
    setErr("");
    try {
      await api(`/v1/spaces/${space.id}/ask/threads/${tid}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== tid));
      if (threadId === tid) {
        clearRevealTimers();
        setReveal(null);
        setThreadId(null);
        setMessages([]);
      }
      setDeleteTarget(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!deleteTarget) return;
    deleteCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) setDeleteTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteTarget, deleting]);

  function selectedIdsFromRecord(sel: Record<string, boolean>, cites: DisplayCitation[]): string[] {
    const ids = new Set<string>();
    for (const c of cites) {
      if (sel[c.note_id] !== false) ids.add(c.note_id);
    }
    return [...ids];
  }

  function defaultSelected(cites: DisplayCitation[]): Record<string, boolean> {
    const sel: Record<string, boolean> = {};
    for (const c of cites) sel[c.note_id] = true;
    return sel;
  }

  /** After retrieve-only: scan sources, then enter pick (do not generate yet). */
  function runRetrieveThenPick(
    payload: Omit<RevealState, "phase" | "activeIndex" | "displayCitations" | "selectedNoteIds" | "answer"> & {
      answer?: string;
      selectedNoteIds?: Record<string, boolean>;
    },
  ) {
    clearRevealTimers();
    const display = selectDisplayCitations(payload.citations, null);
    const selectedNoteIds = payload.selectedNoteIds ?? defaultSelected(display);
    const revealPayload: Omit<RevealState, "phase" | "activeIndex"> = {
      ...payload,
      answer: "",
      displayCitations: display,
      selectedNoteIds,
    };
    if (!display.length || reduced) {
      setReveal({ ...revealPayload, phase: "pick", activeIndex: -1 });
      setBusy(false);
      return;
    }

    setReveal({ ...revealPayload, phase: "retrieve", activeIndex: 0 });
    setBusy(false);

    const step = RETRIEVE_STEP_MS;
    for (let i = 1; i < display.length; i++) {
      const t = setTimeout(() => {
        setReveal((prev) =>
          prev && prev.id === payload.id && prev.phase === "retrieve"
            ? { ...prev, activeIndex: i }
            : prev,
        );
      }, step * i);
      revealTimers.current.push(t);
    }
    const done = setTimeout(() => {
      setReveal((prev) =>
        prev && prev.id === payload.id
          ? { ...prev, phase: "pick", activeIndex: display.length - 1 }
          : prev,
      );
    }, step * display.length + FOLD_HOLD_MS);
    revealTimers.current.push(done);
  }

  /** After generate: brief transition to answer (skip re-scan). */
  function runShowAnswer(
    payload: Omit<RevealState, "phase" | "activeIndex" | "displayCitations" | "selectedNoteIds"> & {
      selectedNoteIds?: Record<string, boolean>;
    },
    after: () => Promise<void>,
  ) {
    clearRevealTimers();
    const display = selectDisplayCitations(payload.citations, payload.answer);
    const selectedNoteIds = payload.selectedNoteIds ?? defaultSelected(display);
    setReveal({
      ...payload,
      displayCitations: display,
      selectedNoteIds,
      phase: "answer",
      activeIndex: display.length ? display.length - 1 : -1,
    });
    setBusy(false);
    try {
      localStorage.setItem(SOURCES_OPEN_KEY, "0");
    } catch {
      /* ignore */
    }
    void after().finally(() => {
      setTimeout(() => {
        setReveal((prev) => (prev && prev.id === payload.id ? null : prev));
      }, 160);
    });
  }

  function cancelPick() {
    const optId = reveal?.optimisticUserId;
    clearRevealTimers();
    setReveal(null);
    setBusy(false);
    if (optId) {
      setMessages((prev) => prev.filter((m) => m.id !== optId));
    }
  }

  function toggleNote(noteId: string) {
    setReveal((prev) => {
      if (!prev || prev.phase !== "pick") return prev;
      const cur = prev.selectedNoteIds[noteId] !== false;
      return {
        ...prev,
        selectedNoteIds: { ...prev.selectedNoteIds, [noteId]: !cur },
      };
    });
  }

  function selectAllNotes() {
    setReveal((prev) => {
      if (!prev || prev.phase !== "pick") return prev;
      return { ...prev, selectedNoteIds: defaultSelected(prev.displayCitations) };
    });
  }

  function selectNoneNotes() {
    setReveal((prev) => {
      if (!prev || prev.phase !== "pick") return prev;
      const sel: Record<string, boolean> = {};
      for (const c of prev.displayCitations) sel[c.note_id] = false;
      return { ...prev, selectedNoteIds: sel };
    });
  }

  async function onGenerate() {
    if (!space || !reveal || reveal.phase !== "pick" || busy) return;
    const query = reveal.pendingQuery || reveal.query || "";
    if (!query.trim()) return;
    const noteIds = selectedIdsFromRecord(reveal.selectedNoteIds, reveal.displayCitations);
    if (!noteIds.length) return;

    setErr("");
    setBusy(true);
    const revealId = reveal.id;
    const optimisticId = reveal.optimisticUserId;

    try {
      const res = await api<AskOut>(`/v1/spaces/${space.id}/ask`, {
        method: "POST",
        body: JSON.stringify({
          q: query,
          query,
          note_ids: noteIds,
          thread_id: threadId || undefined,
          generate: true,
        }),
        timeoutMs: ASK_TIMEOUT_MS,
      });
      const tid = res.thread_id ?? threadId;
      if (tid) setThreadId(tid);
      const cites = res.citations ?? [];
      runShowAnswer(
        {
          id: revealId,
          citations: cites,
          answer: res.answer_markdown,
          query,
          mode: res.mode ?? null,
          ai_failed: Boolean(res.ai_failed),
          ai_error: res.ai_error ?? null,
          pendingQuery: query,
          optimisticUserId: optimisticId,
          selectedNoteIds: Object.fromEntries(noteIds.map((id) => [id, true])),
        },
        async () => {
          if (space) await refreshThreads(space.id);
          if (tid && space) await loadMessages(space.id, tid, { silent: true });
        },
      );
    } catch (er) {
      setErr(er instanceof Error ? er.message : "生成失败");
      setBusy(false);
      // Stay in pick if possible
      setReveal((prev) =>
        prev && prev.id === revealId ? { ...prev, phase: "pick" } : prev,
      );
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!space || busy || reveal?.phase === "retrieve" || reveal?.phase === "pick") return;
    const form = e.currentTarget;
    const query = String(new FormData(form).get("query") ?? "").trim();
    if (!query) return;
    setErr("");
    clearRevealTimers();
    setReveal(null);
    setBusy(true);

    const optimisticId = `local-user-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "user",
        content: query,
        created_at: new Date().toISOString(),
      },
    ]);
    form.reset();

    const revealId = `reveal-${Date.now()}`;

    try {
      // Retrieve-only — no thread_id (avoid empty threads); user picks notes next.
      const res = await api<AskOut>(`/v1/spaces/${space.id}/ask`, {
        method: "POST",
        body: JSON.stringify({
          q: query,
          query,
          generate: false,
        }),
        timeoutMs: ASK_TIMEOUT_MS,
      });
      const cites = res.citations ?? [];
      runRetrieveThenPick({
        id: revealId,
        citations: cites,
        query,
        mode: res.mode ?? null,
        ai_failed: false,
        ai_error: null,
        pendingQuery: query,
        optimisticUserId: optimisticId,
      });
    } catch (er) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setErr(er instanceof Error ? er.message : "提问失败");
      setBusy(false);
      setReveal(null);
    }
  }

  const activeTitle =
    threads.find((t) => t.id === threadId)?.title ||
    (threadId ? "对话" : "新对话");

  return (
    <div className="hub-page ask-page">
      <header className="hub-page-head">
        <h1>问答</h1>
        <p className="readonly-banner">
          写作仍在思源 / Notion / 飞书 / Obsidian；中枢只读聚合与问答。回答来自已同步笔记，不会写回任何源。
        </p>
        {space ? (
          <p className="hub-space-chip">
            <span className="hub-space-dot" aria-hidden="true" />
            {space.name}
            <span className="muted"> · {spaceKindLabel(space.kind)}</span>
          </p>
        ) : null}
        {!aiReady ? (
          <p className="hub-hint-pill">
            未配置 AI 端点：问答仅本地抽取，不会调用大模型。
            <Link href="/settings">去设置</Link>
          </p>
        ) : (
          <p className="hub-hint-pill muted">
            已配置 AI：提问将走 Chat Completions；若大模型失败，会回退为检索摘录并标注「AI 失败」。对话会保存在本空间。
          </p>
        )}
      </header>

      <div className="ask-layout">
        <aside className="ask-threads" aria-label="对话列表">
          <div className="ask-threads-head">
            <strong>历史</strong>
            <button type="button" className="ask-new-btn" onClick={startNewChat} disabled={!space}>
              新对话
            </button>
          </div>
          {loadingThreads && !threads.length ? (
            <p className="muted ask-threads-empty">加载中…</p>
          ) : null}
          {!loadingThreads && !threads.length ? (
            <p className="muted ask-threads-empty">还没有记录。提问后会出现在这里。</p>
          ) : null}
          <ul className="ask-thread-list">
            {threads.map((t) => {
              const active = t.id === threadId;
              return (
                <li key={t.id} className={active ? "active" : undefined}>
                  <button
                    type="button"
                    className="ask-thread-item"
                    onClick={() => void selectThread(t.id)}
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="ask-thread-title">{t.title || "未命名"}</span>
                  </button>
                  <button
                    type="button"
                    className="ask-thread-del"
                    title="删除对话"
                    aria-label="删除对话"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      requestDeleteThread(t.id);
                    }}
                  >
                    <IconClose />
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="ask-main">
          <div className="ask-main-head">
            <span className="ask-main-title">{activeTitle}</span>
          </div>

          <div className="ask-feed" ref={feedRef}>
            {loadingMessages ? (
              <div className="hub-state hub-state-loading" aria-busy="true">
                <div className="hub-pulse" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p>载入对话…</p>
              </div>
            ) : null}

            {!loadingMessages && !messages.length && !busy && !reveal && !err ? (
              <div className="hub-state hub-state-idle">
                <strong>带着问题来翻笔记</strong>
                <p className="muted">回答会附上来源引用。对话会在刷新与重新登录后保留。</p>
              </div>
            ) : null}

            {messages.map((m) => {
              if (m.role === "user") {
                return (
                  <motion.div
                    key={m.id}
                    className="ask-bubble ask-bubble-user"
                    initial={reduced ? false : { opacity: 0.85, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: easeOutExpo }}
                  >
                    <p className="ask-bubble-label muted">问</p>
                    <p className="ask-bubble-text">{m.content}</p>
                  </motion.div>
                );
              }
              // Avoid duplicating the in-flight reveal once server messages land
              if (
                reveal &&
                m.role === "assistant" &&
                m === messages[messages.length - 1]
              ) {
                return null;
              }
              const cites = normalizeCitations(m.citations);
              const prevUser = [...messages.slice(0, messages.indexOf(m))]
                .reverse()
                .find((x) => x.role === "user");
              return (
                <motion.div
                  key={m.id}
                  className="ask-bubble ask-bubble-assistant"
                  initial={reduced ? false : { opacity: 0.92, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.26, ease: easeOutExpo }}
                >
                  <AssistantBody
                    content={m.content}
                    citations={cites}
                    mode={m.mode}
                    aiFailed={Boolean(m.ai_failed)}
                    aiError={m.ai_error}
                    reduced={reduced}
                    query={prevUser?.content}
                  />
                </motion.div>
              );
            })}

            {reveal ? (
              <motion.div
                key={reveal.id}
                className="ask-bubble ask-bubble-assistant"
                initial={reduced ? false : { opacity: 0.92, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: easeOutExpo }}
              >
                <AssistantBody
                  content={reveal.phase === "answer" ? reveal.answer : null}
                  citations={reveal.citations}
                  displayCitations={reveal.displayCitations}
                  mode={reveal.mode}
                  aiFailed={reveal.ai_failed}
                  aiError={reveal.ai_error}
                  reduced={reduced}
                  scanning={reveal.phase === "retrieve"}
                  activeIndex={reveal.activeIndex}
                  query={reveal.query}
                  picking={reveal.phase === "pick"}
                  selectedNoteIds={reveal.selectedNoteIds}
                  onToggleNote={toggleNote}
                  onSelectAll={selectAllNotes}
                  onSelectNone={selectNoneNotes}
                  onConfirmGenerate={() => void onGenerate()}
                  onCancelPick={cancelPick}
                  generateDisabled={
                    selectedIdsFromRecord(reveal.selectedNoteIds, reveal.displayCitations)
                      .length === 0
                  }
                  pickLocked={busy && reveal.phase === "pick"}
                />
              </motion.div>
            ) : null}

            {busy ? (
              <AskRetrievePipeline
                reduced={reduced}
                mode={reveal?.phase === "pick" || reveal?.phase === "answer" ? "generate" : "retrieve"}
              />
            ) : null}

            {err ? (
              <div className="hub-state hub-state-error" role="alert">
                <strong>这次没答上来</strong>
                <p>{err}</p>
                <p className="muted">稍后再试，或先确认空间里已有同步笔记。</p>
              </div>
            ) : null}
          </div>

          <form className="ask-prompt-shell ask-prompt-dock" onSubmit={onSubmit}>
            <label className="visually-hidden" htmlFor={inputId}>
              提问
            </label>
            <span className="ask-prompt-icon" aria-hidden="true">
              <IconAsk />
            </span>
            <input
              ref={inputRef}
              id={inputId}
              name="query"
              type="text"
              placeholder="问当前空间的笔记…"
              required
              disabled={
                busy ||
                !space ||
                reveal?.phase === "retrieve" ||
                reveal?.phase === "pick"
              }
              autoComplete="off"
              enterKeyHint="send"
            />
            <SignatureButton
              type="submit"
              disabled={
                busy ||
                !space ||
                reveal?.phase === "retrieve" ||
                reveal?.phase === "pick"
              }
            >
              {busy
                ? reveal?.phase === "pick"
                  ? "生成中…"
                  : "检索中…"
                : reveal?.phase === "retrieve"
                  ? "对照中…"
                  : reveal?.phase === "pick"
                    ? "选择笔记中…"
                    : "提问"}
            </SignatureButton>
          </form>
        </section>
      </div>

      {deleteTarget ? (
        <div
          className="ask-confirm-scrim"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !deleting) setDeleteTarget(null);
          }}
        >
          <div
            className="ask-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ask-del-title"
          >
            <p className="ask-confirm-kicker">删除对话</p>
            <h2 id="ask-del-title">删除「{deleteTarget.title}」？</h2>
            <p className="ask-confirm-body muted">删除后不可恢复。此操作只移除中枢里的问答记录，不会改动任何来源笔记。</p>
            <div className="ask-confirm-actions">
              <button
                type="button"
                className="secondary"
                ref={deleteCancelRef}
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ask-confirm-danger"
                disabled={deleting}
                onClick={() => void confirmDeleteThread()}
              >
                {deleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}