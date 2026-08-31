"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type Island = { id: string; title: string; path: string };

type Extra = {
  this_week?: { notes: number; chars: number; words: number };
  days_since_last?: number | null;
  islands?: Island[];
};

export default function WritingHealthPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [extra, setExtra] = useState<Extra | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(id: string) {
    const r = await api<{ markdown: string; extra?: Extra }>(`/v1/spaces/${id}/writing-health`);
    setMarkdown(r.markdown);
    setExtra(r.extra ?? null);
  }

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    (async () => {
      try {
        const { current } = await loadSpaces();
        if (!current) return;
        setSpace(current);
        await load(current.id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);

  async function generate() {
    if (!space) return;
    setErr("");
    setBusy(true);
    try {
      await load(space.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>写作健康度</h1>
      <p className="readonly-banner">中枢只读。写作健康报告不会写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {err && (
        <p className="err">
          {err}
          {err.includes("writing-health") || err.includes("尚未") ? (
            <>
              {" "}
              <Link href="/skills">去 Skills 安装并启用</Link>
            </>
          ) : null}
        </p>
      )}
      <p>
        <button type="button" onClick={generate} disabled={busy || !space}>
          {busy ? "生成中…" : "生成本周报告"}
        </button>
      </p>
      {extra && (
        <div className="card">
          <p className="muted">
            本周 {extra.this_week?.chars ?? 0} 字
            {extra.days_since_last != null ? ` · 断更 ${extra.days_since_last} 天` : ""}
            {extra.islands ? ` · 孤岛 ${extra.islands.length} 篇` : ""}
          </p>
        </div>
      )}
      {markdown && (
        <div className="card">
          <h2>报告</h2>
          <pre className="report">{markdown}</pre>
        </div>
      )}
      {extra?.islands && extra.islands.length > 0 && (
        <div className="card">
          <h2>孤岛笔记</h2>
          <ul className="list">
            {extra.islands.map((n) => (
              <li key={n.id}>
                <Link href={`/notes/${n.id}`}>{n.title}</Link>
                <div className="muted">{n.path}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
