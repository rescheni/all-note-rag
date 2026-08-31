"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";

export default function NewConnectionPage() {
  const [spaceId, setSpaceId] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    api<{ spaces: { id: string }[] }>("/v1/spaces").then((s) => setSpaceId(s.spaces[0]?.id ?? ""));
  }, []);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setMsg("");
    const fd = new FormData(e.currentTarget);
    try {
      const conn = await api<{ connection: { id: string } }>(`/v1/spaces/${spaceId}/connections`, {
        method: "POST",
        body: JSON.stringify({
          source: "obsidian",
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
        }),
      });
      await api(`/v1/connections/${conn.connection.id}/probe`, { method: "POST" });
      await api(`/v1/connections/${conn.connection.id}/sync`, { method: "POST" });
      setMsg("连接已创建并开始同步。密钥不会出现在 API 响应中。");
      setTimeout(() => (location.href = "/"), 800);
    } catch (er) {
      setErr(er instanceof Error ? er.message : "创建失败");
    }
  }
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h1>新建 Obsidian 连接</h1>
      <p className="muted">指向 Remotely Save 风格的 S3 明文前缀。中枢只读，不会写回 vault。</p>
      {err && <p className="err">{err}</p>}
      {msg && <p>{msg}</p>}
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
    </div>
  );
}
