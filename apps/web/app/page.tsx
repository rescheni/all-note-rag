"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, storeSpaceId, type Space } from "@/lib/space";
import { isRunInProgress, type SyncRunProgress } from "./sync-progress";
import { Heatmap, type HeatDay, type HeatYear } from "./heatmap";
import { prettyPath, shortPath } from "./notes/crumbs";
import { HomeConnShelf } from "./home-conn-shelf";

type Conn = {
  id: string;
  name: string;
  source: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  note_count?: number;
  config?: { endpoint?: string; bucket?: string; workspace_prefix?: string; kernel_base_url?: string };
  latest_run?: SyncRunProgress | null;
};

type Note = { id: string; title: string; path: string; updated_at: string };


export default function HomePage() {
  const [err, setErr] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [space, setSpace] = useState<Space | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [pollUntil, setPollUntil] = useState(0);
  const [activity, setActivity] = useState<HeatDay[]>([]);
  const [activityYears, setActivityYears] = useState<HeatYear[]>([]);
  /** False on SSR + first client paint so auth/role UI does not hydrate-mismatch. */
  const [mounted, setMounted] = useState(false);
  const pollUntilRef = useRef(0);
  pollUntilRef.current = pollUntil;

  async function loadFor(sp: Space) {
    setSpace(sp);
    storeSpaceId(sp.id);
    const c = await api<{ connections: Conn[] }>(`/v1/spaces/${sp.id}/connections`);
    setConns(c.connections);
    const n = await api<{ notes: Note[] }>(`/v1/spaces/${sp.id}/notes`);
    setNotes(n.notes.slice(0, 8));
    const act = await api<{ days: HeatDay[]; years?: HeatYear[] }>(
      `/v1/spaces/${sp.id}/activity?years=all`,
    ).catch(() => ({ days: [] as HeatDay[], years: [] as HeatYear[] }));
    setActivity(act.days ?? []);
    setActivityYears(act.years ?? []);
  }

  async function boot() {
    const { spaces: list, current } = await loadSpaces();
    setSpaces(list);
    if (!current) return;
    await loadFor(current);
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    try {
      if (sessionStorage.getItem("hub_poll_sync")) {
        sessionStorage.removeItem("hub_poll_sync");
        const until = Date.now() + 120000;
        pollUntilRef.current = until;
        setPollUntil(until);
      }
    } catch {
      /* ignore */
    }
    boot().catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, [mounted]);

  const anyRunning = conns.some((c) => isRunInProgress(c.latest_run));

  useEffect(() => {
    if (!space?.id) return;
    const spaceId = space.id;
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      Promise.all([
        api<{ connections: Conn[] }>(`/v1/spaces/${spaceId}/connections`),
        api<{ days: HeatDay[]; years?: HeatYear[] }>(`/v1/spaces/${spaceId}/activity?years=all`).catch(() => ({
          days: [] as HeatDay[],
          years: [] as HeatYear[],
        })),
      ])
        .then(([c, act]) => {
          if (cancelled) return;
          setConns(c.connections);
          setActivity(act.days ?? []);
          setActivityYears(act.years ?? []);
          const running = c.connections.some((x) => isRunInProgress(x.latest_run));
          if (!running && Date.now() >= pollUntilRef.current) setPollUntil(0);
          const delay = running || Date.now() < pollUntilRef.current ? 2000 : 8000;
          timer = window.setTimeout(tick, delay);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(tick, 8000);
        });
    };
    timer = window.setTimeout(tick, anyRunning || Date.now() < pollUntilRef.current ? 2000 : 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [space?.id, pollUntil, anyRunning]);

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


  async function triggerSync(id: string) {
    setErr("");
    try {
      await api(`/v1/connections/${id}/sync`, { method: "POST" });
      const until = Date.now() + 120000;
      pollUntilRef.current = until;
      setPollUntil(until);
      if (space) {
        const c = await api<{ connections: Conn[] }>(`/v1/spaces/${space.id}/connections`);
        setConns(c.connections);
      }
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

      {spaces.length > 1 && (
        <div className="space-bar">
          <div>
            <label htmlFor="space-switch">当前空间</label>
            <select
              id="space-switch"
              value={space?.id ?? ""}
              onChange={(e) => onSwitch(e.target.value)}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <Heatmap days={activity} years={activityYears} />

      {/* Role / auth-dependent siblings only after mount — same tags on SSR & first paint. */}
      {mounted && !canManageConn && space ? (
        <p className="muted">当前账号为只读，可以浏览笔记、搜索与问答，但不能管理连接或同步。</p>
      ) : null}
      <section className="home-conns">
        <div className="home-conns-head">
          <h2>连接</h2>
          {mounted && canManageConn ? (
            <p className="muted home-manage-conn">
              <Link href="/connections">管理接入 →</Link>
            </p>
          ) : null}
        </div>
        {conns.length === 0 && (
          <p className="empty-desk">
            还没有连接。
            {mounted && canManageConn ? (
              <>
                {" "}
                <Link href="/connections">去接入管理</Link>
              </>
            ) : null}
          </p>
        )}
        <p className="muted" style={{ marginTop: 0 }}>
          同步方式：手动「同步」+ 对象存储变更唤醒；自动巡检约每小时一次（仅当距上次同步已超过约 1 小时）。
        </p>
        <HomeConnShelf conns={conns} canSync={Boolean(mounted && canManageConn)} onSync={triggerSync} />
      </section>

      <section>
        <h2>最近笔记</h2>
        {notes.length === 0 && <p className="empty-desk">同步后会出现最近改动的笔记。</p>}
        <ul className="list stagger-in">
          {notes.map((n) => (
            <li key={n.id}>
              <Link href={`/notes/${n.id}`}>{n.title}</Link>
              <div className="muted note-path" title={prettyPath(n.path, n.title) || n.title}>
                {shortPath(n.path, 2, n.title) || n.title}
              </div>
            </li>
          ))}
        </ul>
        <p><Link href="/notes">全部笔记</Link></p>
      </section>
    </>
  );
}
