"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type Note = { id: string; title: string; path: string; updated_at: string };

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [space, setSpace] = useState<Space | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    (async () => {
      try {
        const { current } = await loadSpaces();
        if (!current) return;
        setSpace(current);
        const n = await api<{ notes: Note[] }>(`/v1/spaces/${current.id}/notes`);
        setNotes(n.notes);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);
  return (
    <>
      <h1>笔记列表</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {err && <p className="err">{err}</p>}
      <div className="card">
        <ul className="list">
          {notes.map((n) => (
            <li key={n.id}>
              <Link href={`/notes/${n.id}`}>{n.title}</Link>
              <div className="muted">{n.path}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
