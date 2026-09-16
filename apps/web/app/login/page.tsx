"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, setToken } from "@/lib/api";
import Link from "next/link";
import { SignatureButton } from "../ui-motion";

export default function LoginPage() {
  const [err, setErr] = useState("");
  // null = 尚未知；true/false = 服务端配置
  const [allowRegister, setAllowRegister] = useState<boolean | null>(null);

  useEffect(() => {
    api<{ allow_registration: boolean }>("/v1/auth/config")
      .then((c) => setAllowRegister(Boolean(c.allow_registration)))
      // 配置接口不可用时不阻断登录，保持旧行为（展示注册入口）
      .catch(() => setAllowRegister(true));
  }, []);

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
      {allowRegister === false ? (
        <p className="muted">本站已关闭自助注册，请联系管理员开通账号。</p>
      ) : (
        <p className="muted">
          没有账号？<Link href="/register">注册</Link>
        </p>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        为防暴力破解，连续输错将在数分钟内临时锁定，请稍后再试。
      </p>
    </div>
  );
}
