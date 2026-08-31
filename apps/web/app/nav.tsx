"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getToken, setToken } from "@/lib/api";

export function Nav() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(Boolean(getToken())), []);
  return (
    <header className="top">
      <div className="wrap">
        <Link className="brand" href="/">笔记中枢</Link>
        {authed ? (
          <>
            <Link href="/">空间</Link>
            <Link href="/notes">笔记</Link>
            <Link href="/search">搜索</Link>
            <Link href="/connections/new">接入</Link>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setToken(null);
                location.href = "/login";
              }}
            >
              退出
            </a>
          </>
        ) : (
          <>
            <Link href="/login">登录</Link>
            <Link href="/register">注册</Link>
          </>
        )}
      </div>
    </header>
  );
}
