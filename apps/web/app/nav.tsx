"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getToken, setToken } from "@/lib/api";
import { getStoredSpaceId, SPACE_CHANGE_EVENT } from "@/lib/space";

export function Nav() {
  const [authed, setAuthed] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  useEffect(() => {
    setAuthed(Boolean(getToken()));
    const sync = () => setSpaceId(getStoredSpaceId());
    sync();
    window.addEventListener(SPACE_CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SPACE_CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return (
    <header className="top">
      <div className="wrap">
        <Link className="brand" href="/">笔记中枢</Link>
        {authed ? (
          <>
            <Link href="/">空间</Link>
            <Link href="/notes">笔记</Link>
            <Link href="/search">搜索</Link>
            <Link href="/ask">问答</Link>
            <Link href="/growth">成长</Link>
            <Link href="/skills">Skills</Link>
            <Link href="/connections/new">接入</Link>
            {spaceId && <Link href={`/spaces/${spaceId}/members`}>成员</Link>}
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
