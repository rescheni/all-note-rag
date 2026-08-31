"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type EventRow = {
  id: string;
  kind: string;
  happened_at: string;
  payload: { title?: string };
  note_id: string | null;
  note_title?: string | null;
};

const KIND_LABEL: Record<string, string> = {
  goal: "目标",
  habit: "习惯",
  mood: "心情",
  review: "复盘",
  focus: "专注",
};

export default function GrowthPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [report, setReport] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(id: string) {
    const r = await api<{ events: EventRow[] }>(`/v1/spaces/${id}/growth`);
    setEvents(r.events);
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
        if (current.kind === "team") return;
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
      const r = await api<{ markdown: string }>(`/v1/spaces/${space.id}/growth/report`);
      setReport(r.markdown);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }

  const team = space?.kind === "team";

  return (
    <>
      <h1>成长</h1>
      <p className="readonly-banner">成长分析仅用于个人空间。中枢只读，不写回任何源。</p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {team && <p className="err">成长分析仅用于个人空间</p>}
      {err && <p className="err">{err}</p>}
      {!team && (
        <>
          <p>
            <button type="button" onClick={generate} disabled={busy || !space}>
              {busy ? "生成中…" : "生成本周周报"}
            </button>
          </p>
          {report && (
            <div className="card">
              <h2>周报</h2>
              <pre className="report">{report}</pre>
            </div>
          )}
          <div className="card">
            <h2>事件</h2>
            {events.length === 0 && <p className="muted">还没有成长事件。同步带目标/习惯标签的日记后会出现在这里。</p>}
            <ul className="list">
              {events.map((e) => (
                <li key={e.id}>
                  <strong>{KIND_LABEL[e.kind] ?? e.kind}</strong>
                  {" "}
                  {e.note_id ? (
                    <Link href={`/notes/${e.note_id}`}>{e.payload?.title || e.note_title || e.note_id}</Link>
                  ) : (
                    e.payload?.title || "手工事件"
                  )}
                  <div className="muted">{new Date(e.happened_at).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
