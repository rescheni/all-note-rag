"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { getStoredSpaceId, SPACE_CHANGE_EVENT } from "@/lib/space";
import {
  IconAsk,
  IconConnect,
  IconGrowth,
  IconLogin,
  IconLogout,
  IconMeetings,
  IconMembers,
  IconNotes,
  IconSearch,
  IconSkills,
  IconSpace,
  IconWriting,
  IconAi,
} from "./icons";

function itemActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/connections/new") return path.startsWith("/connections");
  return path === href || path.startsWith(`${href}/`);
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const path = usePathname() || "/";
  const active = itemActive(path, href);
  return (
    <Link href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
      {icon}
      <span>{children}</span>
    </Link>
  );
}

export function Nav() {
  const path = usePathname() || "/";
  const [authed, setAuthed] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState({ top: 0, height: 0, visible: false });
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
  useEffect(() => {
    const el = navRef.current?.querySelector("a.active") as HTMLElement | null;
    if (!el) {
      setInd((s) => ({ ...s, visible: false }));
      return;
    }
    setInd({ top: el.offsetTop, height: el.offsetHeight, visible: true });
  }, [path, authed, spaceId]);
  return (
    <aside className="rail">
      <Link className="brand" href="/">
        笔记中枢
      </Link>
      <nav aria-label="主导航" ref={navRef}>
        <span
          className="nav-indicator"
          style={{
            transform: `translateY(${ind.top}px)`,
            height: ind.height,
            opacity: ind.visible ? 1 : 0,
          }}
        />
        {authed ? (
          <>
            <NavLink href="/" icon={<IconSpace />}>
              空间
            </NavLink>
            <NavLink href="/notes" icon={<IconNotes />}>
              笔记
            </NavLink>
            <NavLink href="/search" icon={<IconSearch />}>
              搜索
            </NavLink>
            <NavLink href="/ask" icon={<IconAsk />}>
              问答
            </NavLink>
            <NavLink href="/settings" icon={<IconAi />}>
              AI
            </NavLink>
            <div className="nav-gap" />
            <NavLink href="/growth" icon={<IconGrowth />}>
              成长
            </NavLink>
            <NavLink href="/meetings" icon={<IconMeetings />}>
              会议
            </NavLink>
            <NavLink href="/writing-health" icon={<IconWriting />}>
              写作
            </NavLink>
            <NavLink href="/skills" icon={<IconSkills />}>
              Skills
            </NavLink>
            <div className="nav-gap" />
            <NavLink href="/connections/new" icon={<IconConnect />}>
              接入
            </NavLink>
            {spaceId && (
              <NavLink href={`/spaces/${spaceId}/members`} icon={<IconMembers />}>
                成员
              </NavLink>
            )}
            <button
              type="button"
              className="linkish nav-exit"
              onClick={() => {
                void api("/v1/auth/logout", { method: "POST" }).catch(() => undefined);
                setToken(null);
                location.href = "/login";
              }}
            >
              <IconLogout />
              <span>退出</span>
            </button>
          </>
        ) : (
          <>
            <NavLink href="/login" icon={<IconLogin />}>
              登录
            </NavLink>
            <NavLink href="/register" icon={<IconLogin />}>
              注册
            </NavLink>
          </>
        )}
      </nav>
    </aside>
  );
}
