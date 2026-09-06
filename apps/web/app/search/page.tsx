"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";

type SourceHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  connection_id?: string;
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

function pathParent(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function shelfHref(hit: { connection_id?: string; path: string }): string | null {
  if (!hit.connection_id) return null;
  const parent = pathParent(hit.path);
  const q = new URLSearchParams({ book: hit.connection_id });
  if (parent) q.set("path", parent);
  return `/notes?${q.toString()}`;
}

export default function SearchPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [results, setResults] = useState<SourceHit[]>([]);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [didSearch, setDidSearch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
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
    const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    setQuery(q);
    setErr("");
    setLoading(true);
    setDidSearch(false);
    try {
      const out = await api<{ results?: SourceHit[]; similar?: SimilarHit[] }>(
        `/v1/spaces/${space.id}/search?q=${encodeURIComponent(q)}`,
      );
      setResults(out.results ?? []);
      setSimilar(out.similar ?? []);
      setDidSearch(true);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "搜索失败");
      setResults([]);
      setSimilar([]);
      setDidSearch(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <h1>搜索</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {!space && !err && <p className="muted">正在加载空间…</p>}
      <form className="search-bar" onSubmit={onSubmit}>
        <input name="q" type="text" placeholder="搜索标题、路径或正文…" disabled={!space || loading} />
        <button type="submit" className="signature" disabled={!space || loading}>
          {loading ? "搜索中…" : "搜索"}
        </button>
      </form>
      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">正在搜索…</p>}
      {didSearch && !loading && (
        <>
          <h2>源文件{query ? ` · 「${query}」` : ""}</h2>
          <ul className="list stagger-in">
            {results.length === 0 && (
              <li className="muted">没有找到匹配的笔记。试试更短的关键词，或换个空间。</li>
            )}
            {results.map((h) => {
              const shelf = shelfHref(h);
              return (
                <li key={h.note_id + (h.source_block_id ?? "")}>
                  <Link href={h.preview_url || `/notes/${h.note_id}`}>{decodeSegment(h.title) || "(无标题)"}</Link>
                  {h.match === "path" ? <span className="muted"> · 路径</span> : null}
                  <PathCrumbs path={h.path} title={h.title} />
                  {shelf ? (
                    <div className="muted">
                      <Link href={shelf}>在书架中打开</Link>
                    </div>
                  ) : null}
                  <div>{h.snippet}</div>
                </li>
              );
            })}
          </ul>
          <h2>相似文件</h2>
          <ul className="list stagger-in">
            {similar.length === 0 && <li className="muted">暂无相似文件（或相似检索超时已跳过）</li>}
            {similar.map((h) => (
              <li key={h.note_id}>
                <Link href={h.preview_url || `/notes/${h.note_id}`}>{decodeSegment(h.title) || "(无标题)"}</Link>
                <PathCrumbs path={h.path} title={h.title} />
                <div>{h.snippet}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
