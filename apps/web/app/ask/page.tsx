"use client";
import { FormEvent, useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";
import { IconAsk } from "../icons";
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
};

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

export default function AskPage() {
  const reduced = useReducedMotion();
  const inputId = useId();
  const [space, setSpace] = useState<Space | null>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<AskOut | null>(null);
  const [err, setErr] = useState("");
  const [aiReady, setAiReady] = useState(true);
  const [asked, setAsked] = useState("");

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    loadSpaces()
      .then(({ current }) => setSpace(current))
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
    api<{ configured?: boolean }>("/v1/settings/ai")
      .then((s) => setAiReady(Boolean(s.configured)))
      .catch(() => setAiReady(false));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!space) return;
    const query = String(new FormData(e.currentTarget).get("query") ?? "").trim();
    setErr("");
    setBusy(true);
    setAsked(query);
    try {
      const res = await api<AskOut>(`/v1/spaces/${space.id}/ask`, {
        method: "POST",
        body: JSON.stringify({ query }),
      });
      setOut(res);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "提问失败");
    } finally {
      setBusy(false);
    }
  }

  const showCites = out && !out.unknown && out.citations.length > 0;

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
          <p className="hub-hint-pill muted">已配置 AI：提问将走 Chat Completions，失败时会给出明确错误（不再静默降级）。</p>
        )}
      </header>

      <form className="ask-prompt-shell" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor={inputId}>
          提问
        </label>
        <span className="ask-prompt-icon" aria-hidden="true">
          <IconAsk />
        </span>
        <input
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

      {err ? (
        <div className="hub-state hub-state-error" role="alert">
          <strong>这次没答上来</strong>
          <p>{err}</p>
          <p className="muted">稍后再试，或先确认空间里已有同步笔记。</p>
        </div>
      ) : null}

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

      {!out && !busy && !err ? (
        <div className="hub-state hub-state-idle">
          <strong>带着问题来翻笔记</strong>
          <p className="muted">回答会附上来源引用。先同步，再提问，痕迹可溯。</p>
        </div>
      ) : null}

      {out && !busy ? (
        <motion.section
          className="ask-result"
          initial={reduced ? false : { opacity: 0.92, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: easeOutExpo }}
          key={asked}
        >
          {asked ? (
            <p className="ask-asked muted">
              问 · <span>{asked}</span>
            </p>
          ) : null}

          {out.mode ? (
            <p className="ask-mode-pill muted">
              {out.mode === "ai" ? "回答来自大模型（附引用）" : "回答为本地抽取（未走大模型）"}
            </p>
          ) : null}

          <article className="ask-answer-paper">
            <SafeMarkdown source={out.answer_markdown} />
          </article>

          {showCites ? (
            <>
              <div className="cite-chip-row" aria-label="来源速览">
                {out!.citations.map((c, i) => (
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
                      <span className="cite-chip-t">
                        {decodeSegment(c.title) || "未命名"}
                      </span>
                    </Link>
                  </motion.div>
                ))}
              </div>

              <h2 className="ask-cites-h">来源</h2>
              <motion.div
                className="cite-stack"
                variants={reduced ? undefined : listVariants}
                initial={reduced ? false : "hidden"}
                animate="show"
              >
                {out!.citations.map((c, i) => {
                  const shelf = shelfHref(c);
                  return (
                    <motion.article
                      key={c.note_id + (c.source_block_id || c.block_id)}
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
                        {c.quote ? (
                          <blockquote className="ask-quote">{c.quote}</blockquote>
                        ) : null}
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
          ) : out.unknown || out.citations.length === 0 ? (
            <p className="hub-inline-empty muted">这次没有可点的来源卡片。</p>
          ) : null}
        </motion.section>
      ) : null}
    </div>
  );
}
