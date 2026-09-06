"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { SafeMarkdown } from "@/lib/safe-markdown";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";

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
};

function shelfHref(c: Citation): string | null {
  if (!c.connection_id || !c.path) return null;
  const parts = c.path.split("/").filter(Boolean);
  const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const q = new URLSearchParams({ book: c.connection_id });
  if (parent) q.set("path", parent);
  return `/notes?${q.toString()}`;
}

export default function AskPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<AskOut | null>(null);
  const [err, setErr] = useState("");
  const [aiReady, setAiReady] = useState(true);

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

  return (
    <>
      <h1>问答</h1>
      <p className="readonly-banner">中枢只读。回答来自当前空间已同步的笔记，不会写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {!aiReady && (
        <p className="muted">
          未配置 AI 端点，问答使用本地抽取。<Link href="/settings">去设置</Link>
        </p>
      )}
      <form className="search-bar" onSubmit={onSubmit}>
        <input name="query" type="text" placeholder="问当前空间的笔记…" required />
        <button type="submit" className="signature" disabled={busy || !space}>{busy ? "检索中…" : "提问"}</button>
      </form>
      {err && <p className="err">{err}</p>}
      {out && (
        <>
          <div className="ask-answer card">
            <SafeMarkdown source={out.answer_markdown} />
          </div>
          {out.unknown || out.citations.length === 0 ? null : (
            <>
              <h2>来源</h2>
              <div className="cite-grid">
                {out.citations.map((c) => {
                  const shelf = shelfHref(c);
                  return (
                    <div key={c.note_id + (c.source_block_id || c.block_id)} className="source-card">
                      <Link
                        href={c.preview_url || `/notes/${c.note_id}${c.source_block_id ? `#b-${c.source_block_id}` : ""}`}
                      >
                        <h3>{decodeSegment(c.title) || "未命名"}</h3>
                      </Link>
                      {c.path ? <PathCrumbs path={c.path} title={c.title} /> : null}
                      {c.quote && <blockquote className="ask-quote">{c.quote}</blockquote>}
                      {shelf ? (
                        <div className="muted">
                          <Link href={shelf}>在书架中打开</Link>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
