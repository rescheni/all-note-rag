"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";

type CatalogSkill = {
  id: string;
  name: string;
  description: string;
  version: string;
  hooks: string[];
  official?: boolean;
};

type Installed = {
  space_id: string;
  skill_id: string;
  enabled: boolean;
  version: string;
};

export default function SkillsPage() {
  const [space, setSpace] = useState<Space | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const r = await api<{ catalog: CatalogSkill[]; installed: Installed[] }>("/v1/skills");
    setCatalog(r.catalog);
    setInstalled(r.installed);
  }

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    (async () => {
      try {
        const { current } = await loadSpaces();
        setSpace(current);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);

  const spaceId = space?.id ?? "";
  const isOwner = space?.role === "owner";

  function rowFor(id: string): Installed | undefined {
    return installed.find((i) => i.skill_id === id && (!spaceId || i.space_id === spaceId));
  }

  async function install(skillId: string) {
    setErr("");
    setBusy(skillId);
    try {
      await api(`/v1/spaces/${spaceId}/skills/install`, {
        method: "POST",
        body: JSON.stringify({ skill_id: skillId }),
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "安装失败");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(skillId: string, enabled: boolean) {
    setErr("");
    setBusy(skillId);
    try {
      await api(`/v1/spaces/${spaceId}/skills/${skillId}/enable`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Skills</h1>
      <p className="readonly-banner">
        Skills 在中枢内运行，无源凭证、无外网。不会写回 Notion / 飞书 / 思源 / Obsidian。
      </p>
      {space && <p className="muted">当前空间：{space.name}（{spaceKindLabel(space.kind)}）</p>}
      {!isOwner && space && <p className="muted">仅空间所有者可安装或启停 Skill。</p>}
      {err && <p className="err">{err}</p>}
      {catalog.map((s) => {
        const inst = rowFor(s.id);
        return (
          <div className="card" key={s.id}>
            <div className="skill-row">
              <div>
                <h2 style={{ margin: 0 }}>{s.name}</h2>
                <p className="muted">{s.description}</p>
                <p className="muted">版本 {s.version} · hooks: {s.hooks.join(", ")}</p>
              </div>
              <div>
                {isOwner && !inst && (
                  <button type="button" disabled={!spaceId || busy === s.id} onClick={() => install(s.id)}>
                    安装到当前空间
                  </button>
                )}
                {isOwner && inst && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === s.id}
                    onClick={() => toggle(s.id, !inst.enabled)}
                  >
                    {inst.enabled ? "停用" : "启用"}
                  </button>
                )}
              </div>
            </div>
            {inst && (
              <p className="muted">当前空间：{inst.enabled ? "已启用" : "已停用"}</p>
            )}
          </div>
        );
      })}
    </>
  );
}
