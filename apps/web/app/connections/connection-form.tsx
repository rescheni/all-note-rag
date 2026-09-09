"use client";
import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, friendlyErrorMessage, getToken } from "@/lib/api";
import { FeishuQr } from "./feishu-qr";
import { loadSpaces, spaceKindLabel, type Space } from "@/lib/space";
import { isRunInProgress, SyncRunStatus, type SyncRunProgress } from "../sync-progress";
import { SignatureButton, SourcePills } from "../ui-motion";

export const SOURCES = [
  { id: "obsidian", label: "Obsidian" },
  { id: "siyuan", label: "思源" },
  { id: "notion", label: "Notion" },
  { id: "feishu", label: "飞书" },
] as const;

export type SourceId = (typeof SOURCES)[number]["id"];

export type ContactsSyncSnapshot = {
  last_at?: string;
  pulled?: number;
  matched?: number;
  added?: number;
  skipped?: number;
  already_member?: number;
  error?: string;
};

export type ConnectionConfig = {
  endpoint?: string;
  bucket?: string;
  region?: string;
  remote_prefix?: string;
  workspace_prefix?: string;
  kernel_base_url?: string;
  notebook_ids?: string[] | string;
  workspace_id?: string;
  wiki_space_id?: string;
  wiki_node_token?: string;
  mode?: string;
  e2ee?: boolean;
  official_s3?: boolean;
  contacts_sync?: ContactsSyncSnapshot;
};

export type PublicConnection = {
  id: string;
  name: string;
  source: string;
  mode?: string | null;
  status?: string;
  last_error?: string | null;
  space_id?: string;
  config?: ConnectionConfig;
  latest_run?: SyncRunProgress | null;
};

export type SecretFlags = {
  configured: boolean;
  access_key?: boolean;
  secret_key?: boolean;
  token?: boolean;
  access_token?: boolean;
  user_access_token?: boolean;
  refresh_token?: boolean;
  repo_password?: boolean;
  app_id?: boolean;
  app_secret?: boolean;
};

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function pickTypedSecrets(fd: FormData, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = str(fd, k);
    if (v) out[k] = v;
  }
  return out;
}

function notebookIdsValue(cfg?: ConnectionConfig): string {
  const v = cfg?.notebook_ids;
  if (Array.isArray(v)) return v.join(", ");
  return typeof v === "string" ? v : "";
}

function initialSyMode(connection?: PublicConnection): "api" | "workspace" {
  const m = connection?.mode || connection?.config?.mode;
  if (m === "api") return "api";
  return "workspace";
}

type Props = {
  variant: "create" | "edit";
  source?: SourceId | "";
  connection?: PublicConnection;
  secrets?: SecretFlags;
};

export function ConnectionForm({ variant, source: sourceProp = "", connection, secrets }: Props) {
  const router = useRouter();
  const [source, setSource] = useState<SourceId | "">((connection?.source as SourceId) || sourceProp);
  const [syMode, setSyMode] = useState<"api" | "workspace">(initialSyMode(connection));
  const [space, setSpace] = useState<Space | null>(null);
  const [err, setErr] = useState(connection?.last_error || "");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthReady, setOauthReady] = useState<boolean | null>(null);
  const [showFeishuEmbed, setShowFeishuEmbed] = useState(false);
  const [savedId, setSavedId] = useState(connection?.id ?? "");
  const [run, setRun] = useState<SyncRunProgress | null>(connection?.latest_run ?? null);
  const [pollUntil, setPollUntil] = useState(0);

  useEffect(() => {
    setSource((connection?.source as SourceId) || sourceProp);
  }, [sourceProp, connection?.source]);

  useEffect(() => {
    try {
      const flash = sessionStorage.getItem("hub_form_err");
      if (flash) {
        setErr(flash);
        sessionStorage.removeItem("hub_form_err");
      }
      const q = new URLSearchParams(window.location.search);
      const oauthErr = q.get("oauth_error");
      if (oauthErr) {
        const raw = oauthErr;
        const mapped =
          /20029|invalid redirect|redirect.?url|回调地址/i.test(raw)
            ? "飞书回调地址未登记。请在开放平台「安全设置」加入当前站点的回调地址。"
            : friendlyErrorMessage(raw, "飞书授权未完成，请重新扫码。");
        setErr(mapped);
        q.delete("oauth_error");
        const next = `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
        window.history.replaceState({}, "", next);
      }
      if (q.get("oauth") === "ok") {
        const src = connection?.source || sourceProp;
        setMsg(src === "feishu" ? "已通过飞书扫码登录。" : "已通过 Notion 授权。");
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    loadSpaces()
      .then(({ current }) => setSpace(current))
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);

  useEffect(() => {
    if (source !== "notion" && source !== "feishu") return;
    const path = source === "feishu" ? "/v1/connections/oauth/feishu/status" : "/v1/connections/oauth/notion/status";
    api<{ configured: boolean }>(path)
      .then((r) => setOauthReady(r.configured))
      .catch(() => setOauthReady(false));
  }, [source]);

  const connId = savedId || connection?.id || "";
  useEffect(() => {
    if (!connId) return;
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      api<{ runs: SyncRunProgress[] }>(`/v1/connections/${connId}/sync`)
        .then((r) => {
          if (cancelled) return;
          const next = r.runs?.[0] ?? null;
          setRun(next);
          const running = isRunInProgress(next);
          const delay = running || Date.now() < pollUntil ? 2000 : 8000;
          timer = window.setTimeout(tick, delay);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(tick, 8000);
        });
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connId, pollUntil]);

  const editing = variant === "edit" || Boolean(savedId);
  const cfg = connection?.config ?? {};
  const title = useMemo(() => {
    if (editing) {
      if (source === "obsidian") return "编辑 Obsidian 连接";
      if (source === "siyuan") return "编辑思源连接";
      if (source === "notion") return "编辑 Notion 连接";
      if (source === "feishu") return "编辑飞书连接";
      return "编辑连接";
    }
    if (source === "obsidian") return "新建 Obsidian 连接";
    if (source === "siyuan") return "新建思源连接";
    if (source === "notion") return "新建 Notion 连接";
    if (source === "feishu") return "新建飞书连接";
    return "选择一个源";
  }, [source, editing]);

  function secretPh(saved?: boolean) {
    if (!editing) return undefined;
    return saved ? "已保存则留空" : "留空则不修改";
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (!source) {
      setErr("请选择一个源");
      return;
    }
    if (!space?.id) {
      setErr("请先选择空间");
      return;
    }
    if (space.role === "viewer") {
      setErr("只读成员不能保存连接");
      return;
    }
    const fd = new FormData(e.currentTarget);
    let body: Record<string, unknown> = { source };
    if (source === "obsidian") {
      body = {
        source,
        name: str(fd, "name"),
        config: {
          bucket: str(fd, "bucket"),
          region: str(fd, "region") || "us-east-1",
          remote_prefix: str(fd, "remote_prefix"),
          endpoint: str(fd, "endpoint"),
          ignore: [".obsidian/", ".trash/"],
          e2ee: fd.get("e2ee") === "on",
        },
        secrets: pickTypedSecrets(fd, ["access_key", "secret_key"]),
      };
    } else if (source === "siyuan") {
      const mode = (str(fd, "mode") as "api" | "workspace") || syMode;
      const config: Record<string, unknown> = { mode };
      const secrets = pickTypedSecrets(fd, ["token", "access_key", "secret_key", "repo_password"]);
      if (mode === "api") {
        config.kernel_base_url = str(fd, "kernel_base_url");
        config.notebook_ids = str(fd, "notebook_ids");
      } else {
        config.endpoint = str(fd, "endpoint");
        config.bucket = str(fd, "bucket");
        config.region = str(fd, "region") || "us-east-1";
        config.workspace_prefix = str(fd, "workspace_prefix");
      }
      body = { source, name: str(fd, "name"), mode, config, secrets };
    } else if (source === "notion") {
      body = {
        source,
        name: str(fd, "name"),
        config: { workspace_id: str(fd, "workspace_id") },
        secrets: pickTypedSecrets(fd, ["token"]),
      };
    } else if (source === "feishu") {
      let wikiSpace = str(fd, "wiki_space_id");
      let wikiNode = str(fd, "wiki_node_token");
      // Prefer a single primary URL field; never persist a node token as wiki_space_id.
      if (wikiSpace && !/^[0-9]+$/.test(wikiSpace)) {
        if (!wikiNode) wikiNode = wikiSpace;
        wikiSpace = "";
      }
      body = {
        source,
        name: str(fd, "name"),
        config: { wiki_space_id: wikiSpace, wiki_node_token: wikiNode },
        secrets: pickTypedSecrets(fd, ["app_id", "app_secret"]),
      };
    }

    const id = savedId || connection?.id;
    setBusy(true);
    try {
      let connId = id;
      if (editing && id) {
        await api(`/v1/connections/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const created = await api<{ connection: { id: string } }>(`/v1/spaces/${space.id}/connections`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        connId = created.connection.id;
        setSavedId(connId);
      }
      try {
        await api(`/v1/connections/${connId}/probe`, { method: "POST" });
        await api(`/v1/connections/${connId}/sync`, { method: "POST" });
        setMsg("已保存并开始同步。");
        setPollUntil(Date.now() + 120000);
        try {
          sessionStorage.setItem("hub_poll_sync", "1");
        } catch {
          /* ignore */
        }
        try {
          const r = await api<{ runs: SyncRunProgress[] }>(`/v1/connections/${connId}/sync`);
          setRun(r.runs?.[0] ?? null);
        } catch {
          /* ignore */
        }
        setTimeout(() => (location.href = "/"), 800);
      } catch (er) {
        const ex = er as Error & { code?: string };
        const notice =
          (ex.code ? `${ex.code}: ` : "") + (ex.message || "探活或同步失败") + " 连接已保存，可补全后再次保存。";
        setErr(notice);
        if (!editing && connId) {
          try {
            sessionStorage.setItem("hub_form_err", notice);
          } catch {
            /* ignore */
          }
          router.replace(`/connections/${connId}`);
        }
      }
    } catch (er) {
      const ex = er as Error & { code?: string };
      setErr((ex.code ? `${ex.code}: ` : "") + (ex instanceof Error ? ex.message : "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  const canEdit = space?.role !== "viewer";

  return (
    <div className="card form-card">
      <h1>{title}</h1>
      <p className="readonly-banner">中枢只读，不写回。</p>
      {space && (
        <p className="muted">
          当前空间：{space.name}（{spaceKindLabel(space.kind)}）
        </p>
      )}
      {space && space.role === "viewer" && <p className="err">只读成员不能保存连接。</p>}
      {variant === "create" && !editing && (
        <SourcePills items={SOURCES} active={source} />
      )}
      {editing && source && (
        <p className="muted">源：{SOURCES.find((s) => s.id === source)?.label ?? source}</p>
      )}
      {err && <p className="err">{err}</p>}
      {msg && <p className="ok-msg">{msg}</p>}
      {run && <SyncRunStatus run={run} />}
      {!source && <p className="muted">请选择 Obsidian、思源、Notion 或飞书。</p>}

      {source === "obsidian" && (
        <form onSubmit={onSubmit} key={`obsidian-${connection?.id ?? "new"}`}>
          <section className="form-section">
            <h2>连接名称</h2>
            <div className="form-grid">
              <div className="field span-2">
                <label>名称</label>
                <input name="name" defaultValue={connection?.name ?? "我的 Obsidian"} required />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>对象存储</h2>
            <div className="form-grid">
              <div className="field">
                <label>对象存储地址</label>
                <input name="endpoint" defaultValue={cfg.endpoint ?? "http://127.0.0.1:9000"} required />
              </div>
              <div className="field">
                <label>桶</label>
                <input name="bucket" defaultValue={cfg.bucket ?? "obsidian-src"} required />
              </div>
              <div className="field">
                <label>区域</label>
                <input name="region" defaultValue={cfg.region ?? "us-east-1"} />
              </div>
              <div className="field">
                <label>远程前缀</label>
                <input name="remote_prefix" defaultValue={cfg.remote_prefix ?? "vault1"} />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>凭证</h2>
            <div className="form-grid">
              <div className="field">
                <label>Access Key</label>
                <input
                  name="access_key"
                  defaultValue={editing ? "" : "minioadmin"}
                  placeholder={secretPh(secrets?.access_key)}
                  required={!editing}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label>Secret Key</label>
                <input
                  name="secret_key"
                  type="password"
                  defaultValue={editing ? "" : "minioadmin"}
                  placeholder={secretPh(secrets?.secret_key)}
                  required={!editing}
                  autoComplete="off"
                />
              </div>
              <div className="field span-2">
                <label>
                  <input name="e2ee" type="checkbox" defaultChecked={Boolean(cfg.e2ee)} /> 源已开启
                  E2EE（将标记为不可读，不摄入正文）
                </label>
              </div>
            </div>
          </section>
          <div className="form-actions">
            <SignatureButton type="submit" disabled={busy || !canEdit}>
              {busy ? "保存中…" : "保存并同步"}
            </SignatureButton>
            <Link href="/" className="btn secondary">
              返回
            </Link>
          </div>
        </form>
      )}

      {source === "siyuan" && (
        <form onSubmit={onSubmit} key={`siyuan-${connection?.id ?? "new"}`}>
          <section className="form-section">
            <h2>连接名称</h2>
            <div className="form-grid">
              <div className="field span-2">
                <label>名称</label>
                <input name="name" defaultValue={connection?.name ?? "我的思源"} required />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>接入方式</h2>
            <input type="hidden" name="mode" value={syMode} />
            <div className="segmented" role="tablist" aria-label="思源接入方式">
              <button
                type="button"
                className={syMode === "workspace" ? "active" : ""}
                onClick={() => setSyMode("workspace")}
              >
                对象存储
              </button>
              <button type="button" className={syMode === "api" ? "active" : ""} onClick={() => setSyMode("api")}>
                内核 API
              </button>
            </div>
          </section>
          {syMode === "api" ? (
            <>
              <section className="form-section">
                <h2>内核</h2>
                <div className="form-grid">
                  <div className="field">
                    <label>内核地址</label>
                    <input name="kernel_base_url" defaultValue={cfg.kernel_base_url ?? "http://127.0.0.1:6806"} />
                  </div>
                  <div className="field">
                    <label>笔记本 ID（可选，逗号分隔）</label>
                    <input name="notebook_ids" defaultValue={notebookIdsValue(cfg)} />
                  </div>
                </div>
              </section>
              <section className="form-section">
                <h2>凭证</h2>
                <div className="form-grid">
                  <div className="field">
                    <label>Token</label>
                    <input
                      name="token"
                      type="password"
                      placeholder={secretPh(secrets?.token)}
                      autoComplete="off"
                    />
                  </div>
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="form-section">
                <h2>对象存储</h2>
                <p className="hint">官方加密快照请填数据仓库密码；明文 data/*.sy 则填工作区前缀</p>
                <div className="form-grid">
                  <div className="field">
                    <label>对象存储地址</label>
                    <input name="endpoint" defaultValue={cfg.endpoint ?? "http://127.0.0.1:9000"} />
                  </div>
                  <div className="field">
                    <label>桶</label>
                    <input name="bucket" defaultValue={cfg.bucket ?? "siyuan-src"} required />
                  </div>
                  <div className="field">
                    <label>区域</label>
                    <input name="region" defaultValue={cfg.region ?? "us-east-1"} />
                  </div>
                  <div className="field">
                    <label>工作区前缀</label>
                    <input name="workspace_prefix" defaultValue={cfg.workspace_prefix ?? "workspace"} required />
                  </div>
                </div>
              </section>
              <section className="form-section">
                <h2>凭证</h2>
                <div className="form-grid">
                  <div className="field">
                    <label>Access Key</label>
                    <input
                      name="access_key"
                      defaultValue={editing ? "" : "minioadmin"}
                      placeholder={secretPh(secrets?.access_key)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label>Secret Key</label>
                    <input
                      name="secret_key"
                      type="password"
                      defaultValue={editing ? "" : "minioadmin"}
                      placeholder={secretPh(secrets?.secret_key)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field span-2">
                    <label>数据仓库密码</label>
                    <input
                      name="repo_password"
                      type="password"
                      autoComplete="off"
                      placeholder={secretPh(secrets?.repo_password)}
                    />
                  </div>
                </div>
              </section>
            </>
          )}
          <div className="form-actions">
            <SignatureButton type="submit" disabled={busy || !canEdit}>
              {busy ? "保存中…" : "保存并同步"}
            </SignatureButton>
            <Link href="/" className="btn secondary">
              返回
            </Link>
          </div>
        </form>
      )}

      {source === "notion" && (
        <form onSubmit={onSubmit} key={`notion-${connection?.id ?? "new"}`}>
          <section className="form-section">
            <h2>连接名称</h2>
            <div className="form-grid">
              <div className="field span-2">
                <label>名称</label>
                <input name="name" defaultValue={connection?.name ?? "我的 Notion"} required />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>Notion 授权</h2>
            <p className="hint">首选用 Notion 登录。授权后只会同步你勾选的页面与数据库，中枢只读、不写回。</p>
            {secrets?.access_token && <p className="ok-msg">已通过 Notion 授权。</p>}
            {oauthReady === false && (
              <p className="hint">尚未配置 Notion OAuth。可先用下方 Integration Token，或在环境变量中设置 NOTION_CLIENT_ID / NOTION_CLIENT_SECRET。</p>
            )}
            <div className="form-actions">
              <button
                type="button"
                disabled={oauthBusy || !canEdit || !space?.id}
                onClick={async (ev) => {
                  setErr("");
                  setMsg("");
                  if (!space?.id) {
                    setErr("请先选择空间");
                    return;
                  }
                  if (space.role === "viewer") {
                    setErr("只读成员不能授权连接");
                    return;
                  }
                  const form = ev.currentTarget.form;
                  const fd = form ? new FormData(form) : new FormData();
                  const q = new URLSearchParams({
                    space_id: space.id,
                    name: str(fd, "name") || "我的 Notion",
                  });
                  const ws = str(fd, "workspace_id");
                  if (ws) q.set("workspace_id", ws);
                  const id = savedId || connection?.id;
                  if (id) q.set("connection_id", id);
                  setOauthBusy(true);
                  try {
                    const r = await api<{ url: string }>(`/v1/connections/oauth/notion/authorize?${q.toString()}`);
                    if (!r.url) {
                      setErr("无法开始 Notion 授权");
                      return;
                    }
                    window.location.href = r.url;
                  } catch (er) {
                    const ex = er as Error & { code?: string };
                    setErr((ex.code ? `${ex.code}: ` : "") + (ex instanceof Error ? ex.message : "授权失败"));
                  } finally {
                    setOauthBusy(false);
                  }
                }}
              >
                {oauthBusy ? "跳转中…" : "用 Notion 登录授权"}
              </button>
            </div>
            <div className="form-grid">
              <div className="field span-2">
                <label>工作区 ID（可选）</label>
                <input name="workspace_id" defaultValue={cfg.workspace_id ?? ""} />
              </div>
            </div>
            <details className="advanced">
              <summary>高级：使用 Integration Token</summary>
              <p className="hint">内部集成令牌仍可用，已有连接不会中断。留空则不修改已保存的令牌。</p>
              <div className="form-grid">
                <div className="field span-2">
                  <label>Integration Token</label>
                  <input
                    name="token"
                    type="password"
                    placeholder={secretPh(Boolean(secrets?.token || secrets?.access_token))}
                    autoComplete="off"
                  />
                </div>
              </div>
            </details>
          </section>
          <div className="form-actions">
            <SignatureButton type="submit" disabled={busy || !canEdit}>
              {busy ? "保存中…" : "保存并同步"}
            </SignatureButton>
            <Link href="/" className="btn secondary">
              返回
            </Link>
          </div>
        </form>
      )}

      {source === "feishu" && (
        <form onSubmit={onSubmit} key={`feishu-${connection?.id ?? "new"}`}>
          <section className="form-section feishu-scan">
            <h2>用飞书扫码登录</h2>
            <p className="hint">
              将打开飞书官方扫码页，扫完自动回到中枢。访问令牌约 2 小时过期，中枢会用刷新令牌（offline_access）自动续期；只有刷新令牌真正过期时才需要重新扫码。重新扫码会合并到当前连接，保留增量游标与已有笔记，不会全量重拉。
            </p>
            {(secrets?.access_token || secrets?.user_access_token) && (
              <p className="ok-msg">已通过飞书扫码登录。再扫一次可重新授权（增量同步）。</p>
            )}
            {oauthReady === false && (
              <p className="hint">还没配好飞书应用。可先在「高级」里填 App ID / Secret。</p>
            )}
            {!canEdit ? (
              <p className="muted">只读成员不能授权连接。</p>
            ) : !space?.id ? (
              <p className="muted">正在加载空间…</p>
            ) : (
              <div className="form-actions">
                <SignatureButton
                  type="button"
                  disabled={oauthBusy || !canEdit || !space?.id}
                  onClick={async (ev) => {
                    setErr("");
                    setMsg("");
                    if (!space?.id) {
                      setErr("请先选择空间");
                      return;
                    }
                    if (space.role === "viewer") {
                      setErr("只读成员不能授权连接");
                      return;
                    }
                    const form = ev.currentTarget.form;
                    const fd = form ? new FormData(form) : new FormData();
                    const q = new URLSearchParams({
                      space_id: space.id,
                      name: str(fd, "name") || "我的飞书",
                      origin: window.location.origin,
                    });
                    const id = savedId || connection?.id;
                    if (id) q.set("connection_id", id);
                    setOauthBusy(true);
                    try {
                      const r = await api<{ url: string }>(`/v1/connections/oauth/feishu/authorize?${q.toString()}`);
                      if (!r.url) {
                        setErr("无法开始飞书授权");
                        return;
                      }
                      window.location.href = r.url;
                    } catch (er) {
                      const ex = er as Error & { code?: string };
                      setErr((ex.code ? `${ex.code}: ` : "") + (ex instanceof Error ? ex.message : "授权失败"));
                    } finally {
                      setOauthBusy(false);
                    }
                  }}
                >
                  {oauthBusy ? "跳转中…" : "用飞书扫码登录"}
                </SignatureButton>
              </div>
            )}
            <div className="form-grid">
              <div className="field span-2">
                <label>名称</label>
                <input name="name" type="text" defaultValue={connection?.name ?? "我的飞书"} required />
              </div>
            </div>
            {canEdit && space?.id ? (
              <details
                className="advanced"
                onToggle={(e) => setShowFeishuEmbed((e.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>本页嵌入二维码（可选）</summary>
                <p className="hint">嵌入组件在部分应用上会报 4401，扫码请优先用上方官方页。</p>
                {showFeishuEmbed ? (
                  <FeishuQr
                    spaceId={space.id}
                    connectionId={savedId || connection?.id}
                    name={connection?.name ?? "我的飞书"}
                    onError={(m) => setErr(m)}
                  />
                ) : null}
              </details>
            ) : null}
            <div className="form-grid">
              <div className="field span-2">
                <label>知识库链接（推荐）</label>
                <input
                  name="wiki_node_token"
                  type="text"
                  defaultValue={cfg.wiki_node_token ?? ""}
                  placeholder="https://xxx.feishu.cn/wiki/..."
                />
                <p className="hint">
                  粘贴飞书知识库或页面链接（feishu.cn/wiki/...）。同步时会自动解析真实的数字
                  space_id，无需手填知识库 ID。
                </p>
              </div>
            </div>
            <details className="advanced">
              <summary>高级：应用凭证与数字知识库 ID</summary>
              <p className="hint">
                知识库同步请先「用飞书扫码登录」（需要用户授权）。仅填 App
                ID/Secret 时应用必须是该知识库成员。下方「知识库 ID」仅填开放平台返回的纯数字
                space_id；不要把 wiki 链接或节点 token 填到这里。开放平台请开通
                wiki:wiki:readonly、wiki:node:retrieve、docx:document:readonly、drive:drive:readonly、offline_access。
              </p>
              <div className="form-grid">
                <div className="field">
                  <label>App ID</label>
                  <input name="app_id" type="text" defaultValue="" placeholder={secretPh(secrets?.app_id)} autoComplete="off" />
                </div>
                <div className="field">
                  <label>App Secret</label>
                  <input
                    name="app_secret"
                    type="password"
                    placeholder={secretPh(secrets?.app_secret)}
                    autoComplete="off"
                  />
                </div>
                <div className="field span-2">
                  <label>知识库 ID（可选，纯数字）</label>
                  <input
                    name="wiki_space_id"
                    type="text"
                    defaultValue={/^[0-9]+$/.test(String(cfg.wiki_space_id ?? "").trim()) ? cfg.wiki_space_id : ""}
                    placeholder="例如 7385347710194008067"
                  />
                </div>
              </div>
            </details>
          </section>
          <div className="form-actions">
            <button type="submit" className="secondary" disabled={busy || !canEdit}>
              {busy ? "保存中…" : "保存并同步"}
            </button>
            <Link href="/" className="btn secondary">
              返回
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
