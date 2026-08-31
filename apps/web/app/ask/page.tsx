"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";

type Citation = {
  note_id: string;
  block_id: string;
  source_block_id: string;
  title: string;
  quote: string;
  preview_url: string;
};

type AskOut = {
  answer_markdown: string;
  citations: Citation[];
  unknown?: boolean;
};

export default function AskPage() {
  const [spaceId, setSpaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<AskOut | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    api<{ spaces: { id: string }[] }>("/v1/spaces").then((s) => setSpaceId(s.spaces[0]?.id ?? ""));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const query = String(new FormData(e.currentTarget).get("query") ?? "").trim();
    setErr("");
    setBusy(true);
    try {
      const res = await api<AskOut>(`/v1/spaces/${spaceId}/ask`, {
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
      <form className="search-bar card" onSubmit={onSubmit}>
        <input name="query" type="text" placeholder="问当前空间的笔记…" required />
        <button type="submit" disabled={busy || !spaceId}>{busy ? "检索中…" : "提问"}</button>
      </form>
      {err && <p className="err">{err}</p>}
      {out && (
        <>
          <div className="ask-answer card">{out.answer_markdown}</div>
          {out.unknown || out.citations.length === 0 ? null : (
            <>
              <h2>来源</h2>
              <div className="cite-grid">
                {out.citations.map((c) => (
                  <Link
                    key={c.note_id + (c.source_block_id || c.block_id)}
                    className="source-card"
                    href={c.preview_url || `/notes/${c.note_id}${c.source_block_id ? `#b-${c.source_block_id}` : ""}`}
                  >
                    <h3>{c.title}</h3>
                    {c.quote && <blockquote className="ask-quote">{c.quote}</blockquote>}
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
