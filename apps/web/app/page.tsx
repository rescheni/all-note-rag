"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";

type Space = { id: string; name: string; kind: string; role: string };
type Conn = { id: string; name: string; source: string; status: string; last_sync_at: string | null; last_error: string | null };
type Note = { id: string; title: string; path: string; updated_at: string };

const SOURCES = [
  { id: "obsidian", label: "Obsidian", hint: "明文 S3 前缀" },
  { id: "siyuan", label: "思源", hint: "内核 API 或明文 data/" },
  { id: "notion", label: "Notion", hint: "探活 token，列表稍后" },
  { id: "feishu", label: "飞书", hint: "探活应用凭证，列表稍后" },
] as const;

export default function HomePage() {
  const [err, setErr] = useState("");
  const [space, setSpace] = useState<Space | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    (async () => {
      try {
        const s = await api<{ spaces: Space[] }>("/v1/spaces");
        const sp = s.spaces[0];
        if (!sp) return;
        setSpace(sp);
        const c = await api<{ connections: Conn[] }>(`/v1/spaces/${sp.id}/connections`);
        setConns(c.connections);
        const n = await api<{ notes: Note[] }>(`/v1/spaces/${sp.id}/notes`);
        setNotes(n.notes.slice(0, 8));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);

  async function triggerSync(id: string) {
    setErr("");
    try {
      await api(`/v1/connections/${id}/sync`, { method: "POST" });
      alert("已入队同步");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "同步失败");
    }
  }

  return (
    <>
      <h1>{space ? space.name : "个人空间"}</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {err && <p className="err">{err}</p>}
      <h2>接入一个源</h2>
      <div className="source-grid">
        {SOURCES.map((s) => (
          <Link key={s.id} className="source-card" href={`/connections/new?source=${s.id}`}>
            <h3>{s.label}</h3>
            <p className="muted">{s.hint}</p>
          </Link>
        ))}
      </div>
      <div className="row">
        <div className="card grow">
          <h2>连接</h2>
          {conns.length === 0 && <p className="muted">还没有连接，从上方选择一个源。</p>}
          <ul className="list">
            {conns.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> <span className="muted">{c.source} · {c.status}</span>
                <div className="muted">最近同步：{c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : "从未"}</div>
                {c.last_error && <div className="err">{c.last_error}</div>}
                <button type="button" className="secondary" onClick={() => triggerSync(c.id)}>立即同步</button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card grow">
          <h2>最近笔记</h2>
          <ul className="list">
            {notes.map((n) => (
              <li key={n.id}>
                <Link href={`/notes/${n.id}`}>{n.title}</Link>
                <div className="muted">{n.path}</div>
              </li>
            ))}
          </ul>
          <p><Link href="/notes">全部笔记</Link></p>
        </div>
      </div>
    </>
  );
}
