"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type SourceHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  source_block_id?: string;
  match?: "keyword" | "path";
};
type SimilarHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number;
};

export default function SearchPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [results, setResults] = useState<SourceHit[]>([]);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [didSearch, setDidSearch] = useState(false);
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
      const out = await api<{ results?: SourceHit[]; similar?: SimilarHit[] }>(
        `/v1/spaces/${space.id}/search?q=${encodeURIComponent(q)}`,
      );
      setResults(out.results ?? []);
      setSimilar(out.similar ?? []);
      setDidSearch(true);
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
      {didSearch && (
        <>
          <h2>源文件</h2>
          <ul className="list card">
            {results.length === 0 && <li className="muted">无源文件命中</li>}
            {results.map((h) => (
              <li key={h.note_id + (h.source_block_id ?? "")}>
                <Link href={h.preview_url}>{h.title}</Link>
                <div className="muted">{h.path}</div>
                <div>{h.snippet}</div>
              </li>
            ))}
          </ul>
          <h2>相似文件</h2>
          <ul className="list card">
            {similar.length === 0 && <li className="muted">无相似文件</li>}
            {similar.map((h) => (
              <li key={h.note_id}>
                <Link href={h.preview_url}>{h.title}</Link>
                <div className="muted">{h.path}</div>
                <div>{h.snippet}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
