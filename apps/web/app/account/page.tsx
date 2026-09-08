"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";
import { loadSpaces } from "@/lib/space";
import { MembersPanel } from "../members-panel";

type TokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
};

function fmt(ts: string | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  } catch {
    return ts;
  }
}

export default function AccountPage() {
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [personalSpace, setPersonalSpace] = useState<{ id: string; role: string } | null>(null);

  async function refreshTokens() {
    const r = await api<{ tokens: TokenRow[] }>("/v1/auth/tokens");
    setTokens(r.tokens);
  }

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    api<{ user: { email: string } }>("/v1/me")
      .then((r) => setEmail(r.user.email))
      .catch(() => undefined);
    loadSpaces()
      .then(({ spaces }) => {
        const personal = spaces.find((s) => s.kind === "personal") ?? spaces[0];
        if (personal) setPersonalSpace({ id: personal.id, role: personal.role });
      })
      .catch(() => undefined);
    refreshTokens().catch((e) => setErr(e instanceof Error ? e.message : "加载令牌失败"));
  }, []);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      await api("/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: fd.get("current_password"),
          new_password: fd.get("new_password"),
        }),
      });
      (e.target as HTMLFormElement).reset();
      setOk("密码已更新");
    } catch (er) {
      setErr(er instanceof Error ? er.message : "修改失败");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setCreatedToken(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      const r = await api<{ token: string; id: string; name: string; token_prefix: string }>(
        "/v1/auth/tokens",
        {
          method: "POST",
          body: JSON.stringify({ name: fd.get("name") }),
        },
      );
      setCreatedToken(r.token);
      (e.target as HTMLFormElement).reset();
      setOk("令牌已创建（仅显示一次，请立即复制）");
      await refreshTokens();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setErr("");
    setOk("");
    try {
      await api(`/v1/auth/tokens/${id}`, { method: "DELETE" });
      setOk("令牌已撤销");
      await refreshTokens();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "撤销失败");
    }
  }

  async function copyToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setOk("已复制到剪贴板");
    } catch {
      setOk("请手动选中复制");
    }
  }

  return (
    <>
      <h1>账号</h1>
      <p className="readonly-banner">修改密码、管理 API 令牌，供自动化与 Agent 调用。</p>
      {email && <p className="muted">当前登录：{email}</p>}
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok-msg">{ok}</p>}

      <form className="card form-card" onSubmit={onPassword}>
        <h2>修改密码</h2>
        <label htmlFor="current_password">当前密码</label>
        <input id="current_password" name="current_password" type="password" required autoComplete="current-password" />
        <label htmlFor="new_password">新密码</label>
        <input id="new_password" name="new_password" type="password" required minLength={6} autoComplete="new-password" />
        <p>
          <button type="submit" disabled={busy}>
            {busy ? "保存中…" : "更新密码"}
          </button>
        </p>
      </form>

      <div className="card form-card" style={{ marginTop: "1.25rem" }}>
        <h2>API 令牌</h2>
        <p className="hint">长效令牌以 <code>hub_</code> 开头，创建后只显示一次明文。</p>
        <ul className="list">
          {tokens.length === 0 && <li className="muted">暂无令牌</li>}
          {tokens.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong>{" "}
              <span className="muted">
                {t.token_prefix}… · 创建 {fmt(t.created_at)}
                {t.last_used_at ? ` · 最近使用 ${fmt(t.last_used_at)}` : ""}
              </span>
              <div className="member-actions">
                <button type="button" className="secondary" onClick={() => onRevoke(t.id)}>
                  撤销
                </button>
              </div>
            </li>
          ))}
        </ul>
        <form className="member-add" onSubmit={onCreateToken}>
          <label htmlFor="token_name">名称</label>
          <input id="token_name" name="name" type="text" required placeholder="例如：本地 Agent" />
          <p>
            <button type="submit" disabled={busy}>
              {busy ? "创建中…" : "创建令牌"}
            </button>
          </p>
        </form>
        {createdToken && (
          <div className="token-once" style={{ marginTop: "0.75rem" }}>
            <label>明文令牌（仅此一次）</label>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <code
                style={{
                  flex: 1,
                  minWidth: "12rem",
                  padding: "0.45rem 0.6rem",
                  background: "var(--desk)",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--line)",
                  wordBreak: "break-all",
                }}
              >
                {createdToken}
              </code>
              <button type="button" onClick={copyToken}>
                复制
              </button>
            </div>
          </div>
        )}
      </div>

      {personalSpace && (
        <div style={{ marginTop: "1.25rem" }}>
          <MembersPanel spaceId={personalSpace.id} role={personalSpace.role} spaceKind="personal" />
        </div>
      )}

      <div className="card form-card" style={{ marginTop: "1.25rem" }}>
        <h2>Agent 调用说明</h2>
        <p className="hint">
          Base URL 可用相对路径 <code>/v1</code>，或公网 <code>https://notes.rei0.cn/v1</code>。
        </p>
        <ol className="hint" style={{ paddingLeft: "1.2rem", lineHeight: 1.7 }}>
          <li>
            <strong>登录拿 JWT</strong>：<code>POST /v1/auth/login</code>，JSON{" "}
            <code>{`{ "email", "password" }`}</code>，响应里的 <code>token</code> 放进{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>。
          </li>
          <li>
            <strong>长效令牌</strong>：在此页创建 <code>hub_…</code> 令牌，同样用{" "}
            <code>Authorization: Bearer hub_…</code>，无需浏览器 Cookie。
          </li>
          <li>
            <strong>Basic 认证</strong>：部分 Agent 只支持账号密码时，可用{" "}
            <code>Authorization: Basic base64(email:password)</code> 直接调 <code>/v1/me</code> 等接口。
          </li>
        </ol>
        <pre
          className="hint"
          style={{
            whiteSpace: "pre-wrap",
            background: "var(--desk)",
            padding: "0.75rem 0.9rem",
            borderRadius: "var(--radius)",
            border: "1px solid var(--line)",
            fontSize: "0.8rem",
          }}
        >{`# JWT / hub_ 令牌
curl -H "Authorization: Bearer <token>" https://notes.rei0.cn/v1/me

# Basic
curl -u 'you@example.com:password' https://notes.rei0.cn/v1/me`}</pre>
      </div>
    </>
  );
}
