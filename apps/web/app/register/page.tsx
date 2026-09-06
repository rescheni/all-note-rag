"use client";
import { FormEvent, useState } from "react";
import { api, setToken } from "@/lib/api";
import { SignatureButton } from "../ui-motion";

export default function RegisterPage() {
  const [err, setErr] = useState("");
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    const fd = new FormData(e.currentTarget);
    try {
      const out = await api<{ token: string }>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: fd.get("email"),
          password: fd.get("password"),
          display_name: fd.get("display_name"),
        }),
      });
      setToken(out.token);
      location.href = "/";
    } catch (er) {
      setErr(er instanceof Error ? er.message : "注册失败");
    }
  }
  return (
    <div className="auth-panel">
      <h1>注册</h1>
      <p className="muted">P0 使用本地邮箱账号，注册后自动创建个人空间。</p>
      {err && <p className="err">{err}</p>}
      <form onSubmit={onSubmit}>
        <label>显示名</label>
        <input name="display_name" type="text" placeholder="你的名字" />
        <label>邮箱</label>
        <input name="email" type="email" required />
        <label>密码（至少 6 位）</label>
        <input name="password" type="password" required minLength={6} />
        <p>
          <SignatureButton type="submit">创建账号</SignatureButton>
        </p>
      </form>
    </div>
  );
}
