"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, getToken } from "@/lib/api";
import { loadSpaces, storeSpaceId, type Space } from "@/lib/space";
import { isRunInProgress, type SyncRunProgress } from "./sync-progress";
import { Heatmap, type HeatDay, type HeatYear } from "./heatmap";
import { prettyPath, shortPath } from "./notes/crumbs";
import { HomeConnShelf } from "./home-conn-shelf";
import { motion, springSoft, useReducedMotion } from "./ui-motion";

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

function pickPersonal(list: Space[]): Space | null {
  if (!list.length) return null;
  return list.find((s) => s.kind === "personal") ?? list[0];
}

export default function HomePage() {
  const reduced = useReducedMotion();
  const [err, setErr] = useState("");
  const [space, setSpace] = useState<Space | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [pollUntil, setPollUntil] = useState(0);
  const [activity, setActivity] = useState<HeatDay[]>([]);
  const [activityYears, setActivityYears] = useState<HeatYear[]>([]);
  /** False on SSR + first client paint so auth/role UI does not hydrate-mismatch. */
  const [mounted, setMounted] = useState(false);
  const [booting, setBooting] = useState(true);
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
    setBooting(true);
    try {
      const { spaces: list } = await loadSpaces();
      const current = pickPersonal(list);
      if (!current) return;
      await loadFor(current);
    } finally {
      setBooting(false);
    }
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
    boot().catch((e) => {
      setErr(e instanceof Error ? e.message : "加载失败");
      setBooting(false);
    });
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
  const showLoading = !mounted || booting;

  return (
    <div className="home-desk">
      <motion.header
        className="home-hero"
        initial={reduced ? false : { opacity: 0.72, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springSoft}
      >
        <div className="home-hero-text">
          <h1>{space ? space.name : "我的笔记"}</h1>
          <p className="home-lede">中枢只读，不写回任何源。</p>
        </div>
        {space ? (
          <span className="home-space-pill" title="个人空间">
            <span className="hub-space-dot" aria-hidden="true" />
            个人
          </span>
        ) : null}
      </motion.header>

      {err && <p className="err">{err}</p>}

      {showLoading ? (
        <div className="home-loading" aria-busy="true" aria-live="polite">
          <div className="home-skel home-skel-heat" />
          <div className="home-skel-row">
            <span /><span /><span />
          </div>
          <p className="muted">正在铺开书桌…</p>
        </div>
      ) : (
        <>
          <Heatmap days={activity} years={activityYears} />

          {mounted && !canManageConn && space ? (
            <p className="muted home-role-note">当前账号为只读，可以浏览笔记、搜索与问答，但不能管理连接或同步。</p>
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
            {conns.length === 0 ? (
              <div className="home-empty">
                <p className="empty-desk">还没有接入源。</p>
                {mounted && canManageConn ? (
                  <p className="home-empty-action">
                    <Link href="/connections">去接入思源 / Obsidian / 飞书 / Notion</Link>
                  </p>
                ) : (
                  <p className="muted">请所有者先接入后再回来翻阅。</p>
                )}
              </div>
            ) : (
              <p className="muted home-sync-quiet">
                手动同步 · 对象存储变更会唤醒 · 过期后约每小时巡检一次
              </p>
            )}
            <HomeConnShelf conns={conns} canSync={Boolean(mounted && canManageConn)} onSync={triggerSync} />
          </section>

          <section className="home-recent">
            <div className="home-conns-head">
              <h2>最近笔记</h2>
              <p className="muted">
                <Link href="/notes">全部笔记 →</Link>
              </p>
            </div>
            {notes.length === 0 ? (
              <div className="home-empty">
                <p className="empty-desk">同步后，最近改动的笔记会出现在这里。</p>
              </div>
            ) : (
              <ul className="list stagger-in home-note-list">
                {notes.map((n) => (
                  <li key={n.id}>
                    <Link href={`/notes/${n.id}`}>{n.title}</Link>
                    <div className="muted note-path" title={prettyPath(n.path, n.title) || n.title}>
                      {shortPath(n.path, 2, n.title) || n.title}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
