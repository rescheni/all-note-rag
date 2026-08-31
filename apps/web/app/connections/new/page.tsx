"use client";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, getToken } from "@/lib/api";

const SOURCES = [
  { id: "obsidian", label: "Obsidian" },
  { id: "siyuan", label: "思源" },
  { id: "notion", label: "Notion" },
  { id: "feishu", label: "飞书" },
] as const;

type SourceId = (typeof SOURCES)[number]["id"];

function NewConnectionForm() {
  const sp = useSearchParams();
  const sourceParam = (sp.get("source") || "") as SourceId | "";
  const [source, setSource] = useState<SourceId | "">(sourceParam);
  const [syMode, setSyMode] = useState<"api" | "workspace">("api");
  const [spaceId, setSpaceId] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setSource(sourceParam);
  }, [sourceParam]);

  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    api<{ spaces: { id: string }[] }>("/v1/spaces").then((s) => setSpaceId(s.spaces[0]?.id ?? ""));
  }, []);

  const title = useMemo(() => {
    if (source === "obsidian") return "新建 Obsidian 连接";
    if (source === "siyuan") return "新建思源连接";
    if (source === "notion") return "新建 Notion 连接";
    if (source === "feishu") return "新建飞书连接";
    return "选择一个源";
  }, [source]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (!source) { setErr("请选择一个源"); return; }
    const fd = new FormData(e.currentTarget);
    let body: Record<string, unknown> = { source };
    if (source === "obsidian") {
      body = {
        source,
        name: fd.get("name"),
        config: {
          bucket: fd.get("bucket"),
          region: fd.get("region") || "us-east-1",
          remote_prefix: fd.get("remote_prefix"),
          endpoint: fd.get("endpoint"),
          ignore: [".obsidian/", ".trash/"],
          e2ee: fd.get("e2ee") === "on",
        },
        secrets: {
          access_key: fd.get("access_key"),
          secret_key: fd.get("secret_key"),
        },
      };
    } else if (source === "siyuan") {
      const mode = (fd.get("mode") as string) || syMode;
      body = {
        source,
        name: fd.get("name"),
        mode,
        config: {
          mode,
          official_s3: fd.get("official_s3") === "on",
          kernel_base_url: fd.get("kernel_base_url"),
          notebook_ids: fd.get("notebook_ids"),
          endpoint: fd.get("endpoint"),
          bucket: fd.get("bucket"),
          region: fd.get("region") || "us-east-1",
          workspace_prefix: fd.get("workspace_prefix"),
        },
        secrets: {
          token: fd.get("token"),
          access_key: fd.get("access_key"),
          secret_key: fd.get("secret_key"),
        },
      };
    } else if (source === "notion") {
      body = {
        source,
        name: fd.get("name"),
        config: { workspace_id: fd.get("workspace_id") },
        secrets: { token: fd.get("token") },
      };
    } else if (source === "feishu") {
      body = {
        source,
        name: fd.get("name"),
        config: { wiki_space_id: fd.get("wiki_space_id") },
        secrets: { app_id: fd.get("app_id"), app_secret: fd.get("app_secret") },
      };
    }
    try {
      const conn = await api<{ connection: { id: string } }>(`/v1/spaces/${spaceId}/connections`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      try {
        await api(`/v1/connections/${conn.connection.id}/probe`, { method: "POST" });
        await api(`/v1/connections/${conn.connection.id}/sync`, { method: "POST" });
        setMsg("连接已创建并开始同步。密钥不会出现在 API 响应中。");
        setTimeout(() => (location.href = "/"), 800);
      } catch (er) {
        const ex = er as Error & { code?: string };
        setErr((ex.code ? `${ex.code}: ` : "") + (ex.message || "探活或同步失败") + " 连接已保存。");
      }
    } catch (er) {
      const ex = er as Error & { code?: string };
      setErr((ex.code ? `${ex.code}: ` : "") + (ex instanceof Error ? ex.message : "创建失败"));
    }
  }

  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <h1>{title}</h1>
      <p className="readonly-banner">中枢只读，不写回。</p>
      <div className="source-picker">
        {SOURCES.map((s) => (
          <Link
            key={s.id}
            href={`/connections/new?source=${s.id}`}
            className={source === s.id ? "active" : ""}
          >
            {s.label}
          </Link>
        ))}
      </div>
      {err && <p className="err">{err}</p>}
      {msg && <p>{msg}</p>}
      {!source && <p className="muted">请选择 Obsidian、思源、Notion 或飞书。</p>}
      {source === "obsidian" && (
        <form onSubmit={onSubmit}>
          <label>名称</label>
          <input name="name" defaultValue="我的 Obsidian" required />
          <label>Endpoint</label>
          <input name="endpoint" defaultValue="http://127.0.0.1:9000" required />
          <label>Bucket</label>
          <input name="bucket" defaultValue="obsidian-src" required />
          <label>Region</label>
          <input name="region" defaultValue="us-east-1" />
          <label>Remote prefix</label>
          <input name="remote_prefix" defaultValue="vault1" />
          <label>Access key</label>
          <input name="access_key" defaultValue="minioadmin" required />
          <label>Secret key</label>
          <input name="secret_key" type="password" defaultValue="minioadmin" required />
          <label><input name="e2ee" type="checkbox" /> 源已开启 E2EE（将标记为不可读，不摄入正文）</label>
          <p><button type="submit">保存并同步</button></p>
        </form>
      )}
      {source === "siyuan" && (
        <form onSubmit={onSubmit}>
          <label>名称</label>
          <input name="name" defaultValue="我的思源" required />
          <label>模式</label>
          <label>
            <input type="radio" name="mode" value="api" checked={syMode === "api"} onChange={() => setSyMode("api")} />
            {" "}模式 A · 内核 HTTP API
          </label>
          <label>
            <input type="radio" name="mode" value="workspace" checked={syMode === "workspace"} onChange={() => setSyMode("workspace")} />
            {" "}模式 B · 明文 data/ 前缀
          </label>
          <label><input name="official_s3" type="checkbox" /> 这是官方 S3 同步（不受支持）</label>
          {syMode === "api" ? (
            <>
              <label>内核地址</label>
              <input name="kernel_base_url" defaultValue="http://127.0.0.1:6806" />
              <label>Token</label>
              <input name="token" type="password" />
              <label>笔记本 ID（可选，逗号分隔）</label>
              <input name="notebook_ids" />
            </>
          ) : (
            <>
              <label>Endpoint</label>
              <input name="endpoint" defaultValue="http://127.0.0.1:9000" />
              <label>Bucket</label>
              <input name="bucket" defaultValue="siyuan-src" required />
              <label>Region</label>
              <input name="region" defaultValue="us-east-1" />
              <label>workspace_prefix</label>
              <input name="workspace_prefix" defaultValue="workspace" required />
              <label>Access key</label>
              <input name="access_key" defaultValue="minioadmin" />
              <label>Secret key</label>
              <input name="secret_key" type="password" defaultValue="minioadmin" />
            </>
          )}
          <p><button type="submit">保存并同步</button></p>
        </form>
      )}
      {source === "notion" && (
        <form onSubmit={onSubmit}>
          <label>名称</label>
          <input name="name" defaultValue="我的 Notion" required />
          <label>Integration token</label>
          <input name="token" type="password" required />
          <label>workspace_id（可选）</label>
          <input name="workspace_id" />
          <p className="muted">同步页面与数据库行。需要真实 Integration token；单元测试使用 mock，不打外网。</p>
          <p><button type="submit">保存并同步</button></p>
        </form>
      )}
      {source === "feishu" && (
        <form onSubmit={onSubmit}>
          <label>名称</label>
          <input name="name" defaultValue="我的飞书" required />
          <label>app_id</label>
          <input name="app_id" required />
          <label>app_secret</label>
          <input name="app_secret" type="password" required />
          <label>wiki_space_id（可选）</label>
          <input name="wiki_space_id" />
          <p className="muted">同步知识库 docx。需要真实应用凭证；未填 wiki_space_id 时列表为空。测试使用 mock。</p>
          <p><button type="submit">保存并同步</button></p>
        </form>
      )}
    </div>
  );
}

export default function NewConnectionPage() {
  return (
    <Suspense fallback={<p className="muted">加载中…</p>}>
      <NewConnectionForm />
    </Suspense>
  );
}
