"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, setToken } from "@/lib/api";
import Link from "next/link";
import { SignatureButton } from "../ui-motion";

export default function RegisterPage() {
  const [err, setErr] = useState("");
  // null = 尚未知；false = 服务端已关闭注册
  const [allowRegister, setAllowRegister] = useState<boolean | null>(null);

  useEffect(() => {
    api<{ allow_registration: boolean }>("/v1/auth/config")
      .then((c) => setAllowRegister(Boolean(c.allow_registration)))
      .catch(() => setAllowRegister(true));
  }, []);

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
  if (allowRegister === false) {
    return (
      <div className="auth-panel">
        <h1>注册已关闭</h1>
        <p className="muted">本站已关闭自助注册，请联系管理员开通账号。</p>
        <p className="muted">
          <Link href="/login">← 返回登录</Link>
        </p>
      </div>
    );
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
