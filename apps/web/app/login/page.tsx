"use client";
import { FormEvent, useState } from "react";
import { api, setToken } from "@/lib/api";
import Link from "next/link";
import { SignatureButton } from "../ui-motion";

export default function LoginPage() {
  const [err, setErr] = useState("");
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    const fd = new FormData(e.currentTarget);
    try {
      const out = await api<{ token: string }>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
      });
      setToken(out.token);
      location.href = "/";
    } catch (er) {
      setErr(er instanceof Error ? er.message : "登录失败");
    }
  }
  return (
    <div className="auth-panel">
      <h1>登录</h1>
      {err && <p className="err">{err}</p>}
      <form onSubmit={onSubmit}>
        <label>邮箱</label>
        <input name="email" type="email" required />
        <label>密码</label>
        <input name="password" type="password" required />
        <p>
          <SignatureButton type="submit">登录</SignatureButton>
        </p>
      </form>
      <p className="muted">
        没有账号？<Link href="/register">注册</Link>
      </p>
    </div>
  );
}
