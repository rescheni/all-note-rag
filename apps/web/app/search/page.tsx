"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";

type Hit = { note_id: string; title: string; path: string; snippet: string; preview_url: string; source_block_id?: string };

export default function SearchPage() {
  const [spaceId, setSpaceId] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    api<{ spaces: { id: string }[] }>("/v1/spaces").then((s) => setSpaceId(s.spaces[0]?.id ?? ""));
  }, []);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "");
    setErr("");
    try {
      const out = await api<{ results: Hit[] }>(`/v1/spaces/${spaceId}/search?q=${encodeURIComponent(q)}`);
      setHits(out.results);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "搜索失败");
    }
  }
  return (
    <>
      <h1>搜索</h1>
      <form className="search-bar card" onSubmit={onSubmit}>
        <input name="q" type="text" placeholder="搜索笔记正文…" />
        <button type="submit">搜索</button>
      </form>
      {err && <p className="err">{err}</p>}
      <ul className="list card">
        {hits.map((h) => (
          <li key={h.note_id + (h.source_block_id ?? "")}>
            <Link href={h.preview_url}>{h.title}</Link>
            <div className="muted">{h.path}</div>
            <div>{h.snippet}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
