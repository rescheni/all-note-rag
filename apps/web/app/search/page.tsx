"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type Hit = { note_id: string; title: string; path: string; snippet: string; preview_url: string; source_block_id?: string };

export default function SearchPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    loadSpaces()
      .then(({ current }) => setSpace(current))
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!space) return;
    const q = String(new FormData(e.currentTarget).get("q") ?? "");
    setErr("");
    try {
      const out = await api<{ results: Hit[] }>(`/v1/spaces/${space.id}/search?q=${encodeURIComponent(q)}`);
      setHits(out.results);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "搜索失败");
    }
  }
  return (
    <>
      <h1>搜索</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      <form className="search-bar card" onSubmit={onSubmit}>
        <input name="q" type="text" placeholder="搜索笔记正文…" />
        <button type="submit" disabled={!space}>搜索</button>
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
