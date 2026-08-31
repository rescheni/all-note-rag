"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";

type Note = { id: string; title: string; path: string; updated_at: string };

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    (async () => {
      try {
        const s = await api<{ spaces: { id: string }[] }>("/v1/spaces");
        const id = s.spaces[0]?.id;
        if (!id) return;
        const n = await api<{ notes: Note[] }>(`/v1/spaces/${id}/notes`);
        setNotes(n.notes);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);
  return (
    <>
      <h1>笔记列表</h1>
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
