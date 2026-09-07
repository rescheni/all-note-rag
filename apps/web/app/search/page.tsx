"use client";
import { FormEvent, useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { PathCrumbs, decodeSegment } from "../notes/crumbs";
import { IconSearch } from "../icons";
import {
  SignatureButton,
  easeOutExpo,
  motion,
  springSoft,
  useReducedMotion,
} from "../ui-motion";

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

const listVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.028, delayChildren: 0.04 },
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

function HitCard({
  href,
  title,
  path,
  snippet,
  match,
  shelf,
  reduced,
}: {
  href: string;
  title: string;
  path: string;
  snippet: string;
  match?: "keyword" | "path";
  shelf: string | null;
  reduced: boolean | null;
}) {
  return (
    <motion.li
      className="hit-card"
      variants={reduced ? undefined : itemVariants}
      whileHover={reduced ? undefined : { y: -2 }}
      whileTap={reduced ? undefined : { scale: 0.992 }}
      transition={springSoft}
    >
      <Link href={href} className="hit-card-main">
        <div className="hit-card-head">
          <span className="hit-card-title">{title}</span>
          {match === "path" ? <span className="hit-match">路径</span> : null}
        </div>
        <PathCrumbs path={path} title={title} />
        {snippet ? <p className="hit-snippet">{snippet}</p> : null}
      </Link>
      {shelf ? (
        <div className="hit-card-foot">
          <Link href={shelf} className="hit-shelf">
            在书架中打开
          </Link>
        </div>
      ) : null}
    </motion.li>
  );
}

export default function SearchPage() {
  const reduced = useReducedMotion();
  const inputId = useId();
  const [space, setSpace] = useState<Space | null>(null);
  const [results, setResults] = useState<SourceHit[]>([]);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [didSearch, setDidSearch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
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

  const emptyBoth = didSearch && !loading && results.length === 0 && similar.length === 0;

  return (
    <div className="hub-page search-page">
      <header className="hub-page-head">
        <h1>搜索</h1>
        <p className="readonly-banner">中枢只读，不写回任何源。</p>
        {space ? (
          <p className="hub-space-chip">
            <span className="hub-space-dot" aria-hidden="true" />
            {space.name}
            <span className="muted"> · {spaceKindLabel(space.kind)}</span>
          </p>
        ) : !err ? (
          <p className="muted hub-space-loading">正在加载空间…</p>
        ) : null}
      </header>

      <form className="search-shell" onSubmit={onSubmit} role="search">
        <label className="visually-hidden" htmlFor={inputId}>
          搜索笔记
        </label>
        <span className="search-shell-icon" aria-hidden="true">
          <IconSearch />
        </span>
        <input
          id={inputId}
          name="q"
          type="search"
          placeholder="搜索标题、路径或正文…"
          disabled={!space || loading}
          autoComplete="off"
          enterKeyHint="search"
        />
        <SignatureButton type="submit" disabled={!space || loading}>
          {loading ? "搜索中…" : "搜索"}
        </SignatureButton>
      </form>

      {err ? (
        <div className="hub-state hub-state-error" role="alert">
          <strong>没搜到这次</strong>
          <p>{err}</p>
          <p className="muted">检查网络后重试，或换个关键词。</p>
        </div>
      ) : null}

      {loading ? (
        <div className="hub-state hub-state-loading" aria-busy="true" aria-live="polite">
          <div className="hub-pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>正在翻找笔记…</p>
        </div>
      ) : null}

      {!didSearch && !loading && !err ? (
        <div className="hub-state hub-state-idle">
          <strong>从标题、路径或正文里找</strong>
          <p className="muted">输入关键词后回车。结果会按源文件与相似笔记分组。</p>
        </div>
      ) : null}

      {emptyBoth ? (
        <div className="hub-state hub-state-empty">
          <strong>没有匹配「{query || "…"}」</strong>
          <p className="muted">试试更短的词，换个空间，或先同步源里的笔记。</p>
        </div>
      ) : null}

      {didSearch && !loading && !emptyBoth ? (
        <>
          <section className="search-section" aria-labelledby="search-source-h">
            <h2 id="search-source-h">
              源文件
              {query ? <span className="search-q"> · 「{query}」</span> : null}
              <span className="search-count muted">{results.length}</span>
            </h2>
            {results.length === 0 ? (
              <p className="hub-inline-empty muted">没有源文件命中。下方仍可能有相似笔记。</p>
            ) : (
              <motion.ul
                className="hit-list"
                variants={reduced ? undefined : listVariants}
                initial={reduced ? false : "hidden"}
                animate="show"
                key={`src-${query}-${results.length}`}
              >
                {results.map((h) => (
                  <HitCard
                    key={h.note_id + (h.source_block_id ?? "")}
                    href={h.preview_url || `/notes/${h.note_id}`}
                    title={decodeSegment(h.title) || "(无标题)"}
                    path={h.path}
                    snippet={h.snippet}
                    match={h.match}
                    shelf={shelfHref(h)}
                    reduced={reduced}
                  />
                ))}
              </motion.ul>
            )}
          </section>

          <section className="search-section" aria-labelledby="search-similar-h">
            <h2 id="search-similar-h">
              相似文件
              <span className="search-count muted">{similar.length}</span>
            </h2>
            {similar.length === 0 ? (
              <p className="hub-inline-empty muted">暂无相似文件（或相似检索超时已跳过）</p>
            ) : (
              <motion.ul
                className="hit-list"
                variants={reduced ? undefined : listVariants}
                initial={reduced ? false : "hidden"}
                animate="show"
                key={`sim-${query}-${similar.length}`}
              >
                {similar.map((h) => (
                  <HitCard
                    key={h.note_id}
                    href={h.preview_url || `/notes/${h.note_id}`}
                    title={decodeSegment(h.title) || "(无标题)"}
                    path={h.path}
                    snippet={h.snippet}
                    shelf={null}
                    reduced={reduced}
                  />
                ))}
              </motion.ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
