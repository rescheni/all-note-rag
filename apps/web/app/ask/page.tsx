"use client";
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";
import { IconAsk, IconClose } from "../icons";
import {
  AnimatePresence,
  SignatureButton,
  easeOutExpo,
  motion,
  springSoft,
  springSnap,
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
  mode?: "ai" | "extractive";
  ai_configured?: boolean;
  ai_failed?: boolean;
  ai_error?: string;
  thread_id?: string;
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

/** In-flight reveal after ask returns: index sources, then show answer. */
type RevealState = {
  id: string;
  /** Full citation list for 【n】 marks in the answer. */
  citations: Citation[];
  /** Filtered/numbered cards for the retrieve animation. */
  displayCitations: DisplayCitation[];
  answer: string;
  mode?: string | null;
  ai_failed?: boolean;
  ai_error?: string | null;
  phase: "retrieve" | "answer";
  activeIndex: number;
};

const ASK_TIMEOUT_MS = 180_000;
const SOURCES_OPEN_KEY = "note-hub:ask-sources-open";
const RETRIEVE_STEP_MS = 580;

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
 * Prefer citations referenced by 【n】 in the answer when present;
 * always skip empty/garbled quotes. `n` keeps the original 1-based index
 * so hover marks stay aligned with the answer.
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
    if (n >= 1) refs.add(n);
  }
  if (!refs.size) return indexed;
  const preferred = indexed.filter((c) => refs.has(c.n));
  return preferred.length ? preferred : indexed;
}

function useSourcesOpenPref(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SOURCES_OPEN_KEY);
      // Default hidden; only expand if user previously chose open.
      if (raw === "1") setOpen(true);
      else setOpen(false);
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
}: {
  citations: DisplayCitation[];
  reduced: boolean | null;
  /** Step-through retrieve animation */
  scanning?: boolean;
  activeIndex?: number;
  /** While scanning, keep body open */
  forceOpen?: boolean;
}) {
  const [prefOpen, setPrefOpen] = useSourcesOpenPref();
  const wasScanning = useRef(false);
  const open = forceOpen || scanning ? true : prefOpen;
  const panelId = useId();

  useEffect(() => {
    if (wasScanning.current && !scanning) {
      // Search-find effect done → fold sources away above the answer.
      setPrefOpen(false);
    }
    wasScanning.current = Boolean(scanning);
  }, [scanning, setPrefOpen]);

  if (!citations.length) {
    return <p className="hub-inline-empty muted">这次没有可点的来源卡片。</p>;
  }

  const visible = scanning
    ? citations.slice(0, Math.max(0, (activeIndex ?? 0) + 1))
    : citations;

  return (
    <div className={`ask-cites${scanning ? " ask-cites-scanning" : ""}`}>
      <div className="cite-chip-row" aria-label="来源速览">
        <AnimatePresence initial={false}>
          {visible.map((c, i) => {
            const active = scanning && i === activeIndex;
            return (
              <motion.div
                key={`chip-${c.n}-${c.note_id}-${c.source_block_id || c.block_id}`}
                layout
                initial={scanning && !reduced ? { opacity: 0, y: 6, scale: 0.9 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, scale: 0.94 }}
                transition={springSnap}
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

      <div className="ask-cites-toggle-row">
        <button
          type="button"
          className="ask-cites-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={Boolean(forceOpen || scanning)}
          onClick={() => setPrefOpen(!prefOpen)}
        >
          <span className="ask-cites-chevron" aria-hidden="true" data-open={open ? "1" : "0"} />
          <span className="ask-cites-h">来源</span>
          <span className="ask-cites-count muted">{citations.length}</span>
          {scanning ? (
            <span className="ask-retrieve-live muted" aria-live="polite">
              找到 {(activeIndex ?? 0) + 1} / {citations.length} · 正在往下搜寻…
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
            transition={{ duration: 0.28, ease: easeOutExpo }}
            style={{ overflow: "hidden" }}
          >
            <div className="cite-stack">
              <AnimatePresence initial={false}>
                {visible.map((c, i) => {
                  const shelf = shelfHref(c);
                  const active = scanning && i === activeIndex;
                  return (
                    <motion.article
                      key={`card-${c.n}-${c.note_id}-${c.source_block_id || c.block_id}`}
                      layout
                      className={`cite-card${active ? " cite-card-active" : ""}`}
                      initial={
                        scanning && !reduced
                          ? { opacity: 0, y: 16, scale: 0.96 }
                          : reduced
                            ? false
                            : { opacity: 0, y: 8 }
                      }
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={reduced ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
                      transition={scanning ? springSnap : springSoft}
                      whileHover={reduced || scanning ? undefined : { y: -2 }}
                    >
                      <Link href={citeHref(c)} className="cite-card-main">
                        <div className="cite-card-head">
                          <span className="cite-chip-n" aria-hidden="true">
                            {c.n}
                          </span>
                          <h3>{decodeSegment(c.title) || "未命名"}</h3>
                        </div>
                        {c.path ? <PathCrumbs path={c.path} title={c.title} /> : null}
                        {c.quote ? <blockquote className="ask-quote">{c.quote}</blockquote> : null}
                      </Link>
                      {shelf ? (
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
}) {
  const displayCites =
    displayCitations ?? selectDisplayCitations(citations, content);
  return (
    <>
      {aiFailed && !scanning ? (
        <p className="ask-ai-failed" role="status">
          {`AI 未能生成（${aiError || "未知原因"}）. 以下为检索摘录。`}
        </p>
      ) : mode && !scanning ? (
        <p className="ask-mode-pill muted">
          {mode === "ai" ? "回答来自大模型（附引用）" : "回答为本地抽取（未走大模型）"}
        </p>
      ) : scanning ? (
        <p className="ask-mode-pill muted" aria-live="polite">
          正在搜寻相关笔记…
        </p>
      ) : null}

      {displayCites.length ? (
        <CitationsBlock
          citations={displayCites}
          reduced={reduced}
          scanning={scanning}
          activeIndex={activeIndex}
          forceOpen={scanning}
        />
      ) : !scanning && content != null ? (
        <p className="hub-inline-empty muted">笔记里没有直接依据可点的来源。</p>
      ) : null}

      {content != null && !scanning ? (
        <motion.article
          className="ask-answer-paper"
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: easeOutExpo }}
        >
          <SafeMarkdown source={content} citations={citations} />
        </motion.article>
      ) : null}
    </>
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

  async function deleteThread(tid: string) {
    if (!space) return;
    const title = threads.find((t) => t.id === tid)?.title?.trim() || "此对话";
    if (typeof window !== "undefined" && !window.confirm(`删除「${title}」？删除后不可恢复。`)) {
      return;
    }
    try {
      await api(`/v1/spaces/${space.id}/ask/threads/${tid}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== tid));
      if (threadId === tid) {
        clearRevealTimers();
        setReveal(null);
        setThreadId(null);
        setMessages([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  }

  function runRetrieveThenAnswer(
    payload: Omit<RevealState, "phase" | "activeIndex" | "displayCitations">,
    after: () => Promise<void>,
  ) {
    clearRevealTimers();
    const display = selectDisplayCitations(payload.citations, payload.answer);
    const revealPayload: Omit<RevealState, "phase" | "activeIndex"> = {
      ...payload,
      displayCitations: display,
    };
    if (!display.length || reduced) {
      setReveal({ ...revealPayload, phase: "answer", activeIndex: -1 });
      setBusy(false);
      void after().finally(() => setReveal(null));
      return;
    }

    setReveal({ ...revealPayload, phase: "retrieve", activeIndex: 0 });
    setBusy(false);

    const step = RETRIEVE_STEP_MS;
    for (let i = 1; i < display.length; i++) {
      const t = setTimeout(() => {
        setReveal((prev) =>
          prev && prev.id === payload.id ? { ...prev, activeIndex: i } : prev,
        );
      }, step * i);
      revealTimers.current.push(t);
    }
    // Hold on last hit, then fold sources and reveal answer underneath.
    const done = setTimeout(() => {
      setReveal((prev) =>
        prev && prev.id === payload.id
          ? { ...prev, phase: "answer", activeIndex: display.length - 1 }
          : prev,
      );
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
    }, step * display.length + 520);
    revealTimers.current.push(done);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!space || busy || reveal?.phase === "retrieve") return;
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

    try {
      const res = await api<AskOut>(`/v1/spaces/${space.id}/ask`, {
        method: "POST",
        body: JSON.stringify({
          q: query,
          query,
          thread_id: threadId || undefined,
        }),
        timeoutMs: ASK_TIMEOUT_MS,
      });
      const tid = res.thread_id ?? threadId;
      if (tid) setThreadId(tid);
      const cites = res.citations ?? [];
      const revealId = `reveal-${Date.now()}`;

      runRetrieveThenAnswer(
        {
          id: revealId,
          citations: cites,
          answer: res.answer_markdown,
          mode: res.mode ?? null,
          ai_failed: Boolean(res.ai_failed),
          ai_error: res.ai_error ?? null,
        },
        async () => {
          if (space) await refreshThreads(space.id);
          if (tid && space) await loadMessages(space.id, tid, { silent: true });
        },
      );
    } catch (er) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setErr(er instanceof Error ? er.message : "提问失败");
      setBusy(false);
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
                      void deleteThread(t.id);
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
                />
              </motion.div>
            ) : null}

            {busy ? (
              <div className="hub-state hub-state-loading" aria-busy="true" aria-live="polite">
                <div className="hub-pulse" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p>正在从笔记里检索…</p>
              </div>
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
              disabled={busy || !space || reveal?.phase === "retrieve"}
              autoComplete="off"
              enterKeyHint="send"
            />
            <SignatureButton type="submit" disabled={busy || !space || reveal?.phase === "retrieve"}>
              {busy ? "检索中…" : reveal?.phase === "retrieve" ? "对照中…" : "提问"}
            </SignatureButton>
          </form>
        </section>
      </div>
    </div>
  );
}
