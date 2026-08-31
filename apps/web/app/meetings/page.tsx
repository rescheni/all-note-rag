"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type Meeting = {
  id: string;
  note_id: string | null;
  note_title?: string | null;
  note_path?: string | null;
  created_at: string;
  payload: {
    title?: string;
    attendees?: string[];
    decisions?: string[];
    todos?: Array<{ text: string; done?: boolean }>;
  };
};

export default function MeetingsPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [err, setErr] = useState("");

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
        const r = await api<{ meetings: Meeting[] }>(`/v1/spaces/${current.id}/meetings`);
        setMeetings(r.meetings);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);

  return (
    <>
      <h1>会议</h1>
      <p className="readonly-banner">中枢只读。会议纪要抽取不会写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {err && <p className="err">{err}</p>}
      <div className="card">
        {meetings.length === 0 && <p className="muted">还没有会议纪要。在 Skills 页安装并启用 meeting-extract，同步带「会议 / 纪要」的笔记后会出现在这里。</p>}
        <ul className="list">
          {meetings.map((m) => (
            <li key={m.id}>
              <strong>
                {m.note_id ? (
                  <Link href={`/notes/${m.note_id}`}>{m.payload?.title || m.note_title || m.note_id}</Link>
                ) : (
                  m.payload?.title || "会议"
                )}
              </strong>
              {m.note_path && <div className="muted">{m.note_path}</div>}
              {m.payload?.attendees?.length ? (
                <div className="muted">参会：{m.payload.attendees.join("、")}</div>
              ) : null}
              {m.payload?.decisions?.length ? (
                <ul>
                  {m.payload.decisions.map((d) => (
                    <li key={d}>决议：{d}</li>
                  ))}
                </ul>
              ) : null}
              {m.payload?.todos?.length ? (
                <ul>
                  {m.payload.todos.map((t) => (
                    <li key={t.text}>{t.done ? "☑" : "☐"} {t.text}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
