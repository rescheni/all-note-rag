"use client";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { getStoredSpaceId, SPACE_CHANGE_EVENT } from "@/lib/space";
import {
  IconAsk,
  IconClose,
  IconConnect,
  IconGrowth,
  IconLogin,
  IconLogout,
  IconMeetings,
  IconMenu,
  IconNotes,
  IconSearch,
  IconSkills,
  IconSpace,
  IconWriting,
  IconSettings,
} from "./icons";

function itemActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/connections" || href === "/connections/new") return path.startsWith("/connections");
  return path === href || path.startsWith(`${href}/`);
}

/** 真在取下一页时才出现的一道细苔藓线，120ms 之后才显形，秒开的页面不会闪。 */
function NavPending() {
  const { pending } = useLinkStatus();
  return <span className={`nav-pending${pending ? " on" : ""}`} aria-hidden="true" />;
}

function NavLink({
  href,
  icon,
  children,
  onNavigate,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const path = usePathname() || "/";
  const active = itemActive(path, href);
  return (
    <Link
      href={href}
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      {icon}
      <span>{children}</span>
      <NavPending />
    </Link>
  );
}

type MeUser = { id: string; email: string; display_name: string | null };

export function Nav() {
  const path = usePathname() || "/";
  const [authed, setAuthed] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [me, setMe] = useState<MeUser | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    const token = getToken();
    setAuthed(Boolean(token));
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
    if (!authed) {
      setMe(null);
      return;
    }
    let cancelled = false;
    api<{ user: MeUser }>("/v1/me")
      .then((r) => {
        if (!cancelled) setMe(r.user);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // Close drawer on route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("nav-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("nav-open");
    };
  }, [menuOpen]);

  // 缝线只写 DOM：hover 时跟随；当前路由用 a.active::before，不在此叠一根。
  const place = useCallback((el: HTMLElement | null, mode: "hover" | "rest" = "rest") => {
    const ind = indRef.current;
    if (!ind) return;
    if (!el || mode === "rest") {
      ind.style.opacity = "0";
      return;
    }
    ind.style.height = `${el.offsetHeight}px`;
    ind.style.transform = `translate3d(0, ${el.offsetTop}px, 0)`;
    ind.style.opacity = "1";
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    place(null, "rest");
    const onOver = (e: Event) => {
      if (window.matchMedia("(max-width: 760px)").matches) return;
      const t = (e.target as HTMLElement).closest("a, button.nav-exit") as HTMLElement | null;
      if (!t || !nav.contains(t)) return;
      place(t, "hover");
    };
    const onLeave = () => place(null, "rest");
    nav.addEventListener("mouseover", onOver);
    nav.addEventListener("mouseleave", onLeave);
    return () => {
      nav.removeEventListener("mouseover", onOver);
      nav.removeEventListener("mouseleave", onLeave);
    };
  }, [path, authed, spaceId, place, menuOpen, me]);

  const userLabel = me?.display_name?.trim() || me?.email || "";
  const userTitle = me?.email || userLabel || undefined;

  return (
    <>
      <aside className={`rail${menuOpen ? " is-open" : ""}`}>
        <div className="rail-top">
          <Link className="brand" href="/" onClick={closeMenu}>
            笔记中枢
          </Link>
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={menuOpen}
            aria-controls="hub-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
            <span className="visually-hidden">{menuOpen ? "关闭菜单" : "打开菜单"}</span>
          </button>
        </div>
        <nav id="hub-nav" aria-label="主导航" ref={navRef}>
          <span className="nav-indicator" ref={indRef} aria-hidden="true" />
          {authed ? (
            <>
              <NavLink href="/" icon={<IconSpace />} onNavigate={closeMenu}>
                首页
              </NavLink>
              <NavLink href="/notes" icon={<IconNotes />} onNavigate={closeMenu}>
                笔记
              </NavLink>
              <NavLink href="/search" icon={<IconSearch />} onNavigate={closeMenu}>
                搜索
              </NavLink>
              <NavLink href="/ask" icon={<IconAsk />} onNavigate={closeMenu}>
                问答
              </NavLink>
              <div className="nav-gap" />
              <NavLink href="/growth" icon={<IconGrowth />} onNavigate={closeMenu}>
                成长
              </NavLink>
              <NavLink href="/meetings" icon={<IconMeetings />} onNavigate={closeMenu}>
                会议
              </NavLink>
              <NavLink href="/writing-health" icon={<IconWriting />} onNavigate={closeMenu}>
                写作
              </NavLink>
              <NavLink href="/skills" icon={<IconSkills />} onNavigate={closeMenu}>
                Skills
              </NavLink>
              <div className="nav-gap" />
              <NavLink href="/connections" icon={<IconConnect />} onNavigate={closeMenu}>
                接入
              </NavLink>
              <div className="nav-foot">
                <NavLink href="/settings" icon={<IconSettings />} onNavigate={closeMenu}>
                  设置
                </NavLink>
                {userLabel ? (
                  <Link
                    href="/account"
                    className="nav-user"
                    title={userTitle}
                    onClick={closeMenu}
                  >
                    <span className="nav-user-dot" aria-hidden="true" />
                    <span className="nav-user-name">{userLabel}</span>
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="linkish nav-exit"
                  onClick={() => {
                    closeMenu();
                    void api("/v1/auth/logout", { method: "POST" }).catch(() => undefined);
                    setToken(null);
                    location.href = "/login";
                  }}
                >
                  <IconLogout />
                  <span>退出</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <NavLink href="/login" icon={<IconLogin />} onNavigate={closeMenu}>
                登录
              </NavLink>
              <NavLink href="/register" icon={<IconLogin />} onNavigate={closeMenu}>
                注册
              </NavLink>
            </>
          )}
        </nav>
      </aside>
      {menuOpen ? (
        <button type="button" className="rail-scrim" aria-label="关闭菜单" onClick={closeMenu} />
      ) : null}
    </>
  );
}
