"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, storeSpaceId, type Space } from "@/lib/space";
import { MembersPanel } from "./members-panel";

type Conn = { id: string; name: string; source: string; status: string; last_sync_at: string | null; last_error: string | null };
type Note = { id: string; title: string; path: string; updated_at: string };

const SOURCES = [
  { id: "obsidian", label: "Obsidian", hint: "明文 S3 前缀" },
  { id: "siyuan", label: "思源", hint: "内核 API 或明文 data/" },
  { id: "notion", label: "Notion", hint: "同步页面与数据库行" },
  { id: "feishu", label: "飞书", hint: "同步知识库 docx" },
] as const;

export default function HomePage() {
  const [err, setErr] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [space, setSpace] = useState<Space | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadFor(sp: Space) {
    setSpace(sp);
    storeSpaceId(sp.id);
    const c = await api<{ connections: Conn[] }>(`/v1/spaces/${sp.id}/connections`);
    setConns(c.connections);
    const n = await api<{ notes: Note[] }>(`/v1/spaces/${sp.id}/notes`);
    setNotes(n.notes.slice(0, 8));
  }

  async function boot() {
    const { spaces: list, current } = await loadSpaces();
    setSpaces(list);
    if (!current) return;
    await loadFor(current);
  }

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    boot().catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);

  async function onSwitch(id: string) {
    const next = spaces.find((s) => s.id === id);
    if (!next) return;
    setErr("");
    try {
      await loadFor(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "切换失败");
    }
  }

  async function onCreateTeam(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setCreating(true);
    try {
      const created = await api<{ space: { id: string; name: string; kind: string }; role: string }>(
        "/v1/spaces",
        { method: "POST", body: JSON.stringify({ name: newName.trim(), kind: "team" }) },
      );
      setNewName("");
      const sp: Space = {
        id: created.space.id,
        name: created.space.name,
        kind: created.space.kind,
        role: created.role,
      };
      const next = [...spaces, sp];
      setSpaces(next);
      await loadFor(sp);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function triggerSync(id: string) {
    setErr("");
    try {
      await api(`/v1/connections/${id}/sync`, { method: "POST" });
      alert("已入队同步");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "同步失败");
    }
  }

  const canManageConn = space?.role === "owner" || space?.role === "editor";

  return (
    <>
      <h1>{space ? space.name : "空间"}</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {err && <p className="err">{err}</p>}

      <div className="space-bar card">
        <div>
          <label htmlFor="space-switch">当前空间</label>
          <select
            id="space-switch"
            value={space?.id ?? ""}
            onChange={(e) => onSwitch(e.target.value)}
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{spaceKindLabel(s.kind)}）
              </option>
            ))}
          </select>
        </div>
        <form className="grow" onSubmit={onCreateTeam}>
          <label htmlFor="team-name">新建团队空间</label>
          <div className="search-bar">
            <input
              id="team-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              name="name"
              type="text"
              required
              placeholder="团队名称"
            />
            <button type="submit" disabled={creating || !newName.trim()}>
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>

      {space?.kind === "team" && (
        <>
          <p>
            <Link href={`/spaces/${space.id}/members`}>打开成员页</Link>
          </p>
          <MembersPanel spaceId={space.id} role={space.role} />
        </>
      )}

      {canManageConn ? (
        <>
          <h2>接入一个源</h2>
          <div className="source-grid">
            {SOURCES.map((s) => (
              <Link key={s.id} className="source-card" href={`/connections/new?source=${s.id}`}>
                <h3>{s.label}</h3>
                <p className="muted">{s.hint}</p>
              </Link>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">你是只读成员，可以浏览笔记、搜索与问答，但不能管理连接或同步。</p>
      )}
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
                {canManageConn && (
                  <button type="button" className="secondary" onClick={() => triggerSync(c.id)}>立即同步</button>
                )}
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
