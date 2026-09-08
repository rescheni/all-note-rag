"use client";
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";
import { IconAsk, IconClose } from "../icons";
import {
  SignatureButton,
  easeOutExpo,
  motion,
  springSoft,
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

const ASK_TIMEOUT_MS = 180_000;

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

const listVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.03, delayChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: easeOutExpo },
  },
};

function CitationsBlock({
  citations,
  reduced,
}: {
  citations: Citation[];
  reduced: boolean | null;
}) {
  if (!citations.length) {
    return <p className="hub-inline-empty muted">这次没有可点的来源卡片。</p>;
  }
  return (
    <>
      <div className="cite-chip-row" aria-label="来源速览">
        {citations.map((c, i) => (
          <motion.div
            key={`chip-${c.note_id}-${c.source_block_id || c.block_id}-${i}`}
            whileHover={reduced ? undefined : { y: -1, scale: 1.02 }}
            whileTap={reduced ? undefined : { scale: 0.97 }}
            transition={springSoft}
          >
            <Link href={citeHref(c)} className="cite-chip">
              <span className="cite-chip-n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="cite-chip-t">{decodeSegment(c.title) || "未命名"}</span>
            </Link>
          </motion.div>
        ))}
      </div>

      <h3 className="ask-cites-h">来源</h3>
      <motion.div
        className="cite-stack"
        variants={reduced ? undefined : listVariants}
        initial={reduced ? false : "hidden"}
        animate="show"
      >
        {citations.map((c, i) => {
          const shelf = shelfHref(c);
          return (
            <motion.article
              key={c.note_id + (c.source_block_id || c.block_id) + i}
              className="cite-card"
              variants={reduced ? undefined : itemVariants}
              whileHover={reduced ? undefined : { y: -2 }}
              transition={springSoft}
            >
              <Link href={citeHref(c)} className="cite-card-main">
                <div className="cite-card-head">
                  <span className="cite-chip-n" aria-hidden="true">
                    {i + 1}
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
      </motion.div>
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

  const loadMessages = useCallback(async (spaceId: string, tid: string) => {
    setLoadingMessages(true);
    setErr("");
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
      setErr(e instanceof Error ? e.message : "加载消息失败");
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

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
  }, [messages, busy]);

  function startNewChat() {
    setThreadId(null);
    setMessages([]);
    setErr("");
    inputRef.current?.focus();
  }

  async function selectThread(tid: string) {
    if (!space || tid === threadId) return;
    setThreadId(tid);
    setErr("");
    await loadMessages(space.id, tid);
  }

  async function deleteThread(tid: string) {
    if (!space) return;
    try {
      await api(`/v1/spaces/${space.id}/ask/threads/${tid}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== tid));
      if (threadId === tid) {
        setThreadId(null);
        setMessages([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!space || busy) return;
    const form = e.currentTarget;
    const query = String(new FormData(form).get("query") ?? "").trim();
    if (!query) return;
    setErr("");
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
      const assistant: ChatMessage = {
        id: `local-asst-${Date.now()}`,
        role: "assistant",
        content: res.answer_markdown,
        citations: res.citations ?? [],
        mode: res.mode ?? null,
        ai_failed: Boolean(res.ai_failed),
        ai_error: res.ai_error ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistant]);
      if (space) await refreshThreads(space.id);
      if (tid && space) {
        // Reload from server so ids/order match persistence
        await loadMessages(space.id, tid);
      }
    } catch (er) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setErr(er instanceof Error ? er.message : "提问失败");
    } finally {
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

            {!loadingMessages && !messages.length && !busy && !err ? (
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
              const cites = normalizeCitations(m.citations);
              const aiFailed = Boolean(m.ai_failed);
              return (
                <motion.div
                  key={m.id}
                  className="ask-bubble ask-bubble-assistant"
                  initial={reduced ? false : { opacity: 0.92, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.26, ease: easeOutExpo }}
                >
                  {aiFailed ? (
                    <p className="ask-ai-failed" role="status">
                      {`AI 未能生成（${m.ai_error || "未知原因"}）. 以下为检索摘录。`}
                    </p>
                  ) : m.mode ? (
                    <p className="ask-mode-pill muted">
                      {m.mode === "ai"
                        ? "回答来自大模型（附引用）"
                        : "回答为本地抽取（未走大模型）"}
                    </p>
                  ) : null}
                  <article className="ask-answer-paper">
                    <SafeMarkdown source={m.content} />
                  </article>
                  <CitationsBlock citations={cites} reduced={reduced} />
                </motion.div>
              );
            })}

            {busy ? (
              <div className="hub-state hub-state-loading" aria-busy="true" aria-live="polite">
                <div className="hub-pulse" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p>正在从笔记里找证据…</p>
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
              disabled={busy || !space}
              autoComplete="off"
              enterKeyHint="send"
            />
            <SignatureButton type="submit" disabled={busy || !space}>
              {busy ? "检索中…" : "提问"}
            </SignatureButton>
          </form>
        </section>
      </div>
    </div>
  );
}
