"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, apiOrigin, getToken } from "@/lib/api";
import { siyuanIconToEmoji } from "@/lib/icon";
import { NoteWho } from "./note-who";
import {
  bookSourceLabel,
  decodeSegment,
  isIdSegment,
  pathCrumbs,
  PathTrail,
  prettyPath,
  resolveCrumbs,
  shortPath,
  tailSeg,
  titlesFromNotes,
  trailWithoutBookPrefix,
  type TrailItem,
} from "../crumbs";
import { easeOutExpo, motion, useReducedMotion } from "../../ui-motion";
import { readCachedTheme, subscribeTheme } from "../../theme/store";
import { IconSourceMark } from "../../icons";
import type { HubTheme } from "../../theme/themes";

type SimilarHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number | null;
};

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="note-source-badge" data-source={source} title={bookSourceLabel(source)}>
      <IconSourceMark source={source} className="note-source-mark" />
      {bookSourceLabel(source)}
    </span>
  );
}


/** Strip markdown images/links/URLs so the rail snip is plain prose. */
function stripRailSnippet(raw: string, max = 120): string {
  let t = (raw || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)\]]+/gi, " ")
    .replace(/^[>#\-*+\s]+/gm, " ")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Image-only / punctuation-only leftovers → no snip (title + path remain).
  if (!t || /^[\/|·.•\-—–_\s]+$/.test(t)) return "";
  if (/^(图片\s*[/:：]?\s*)?(assets\/)?[^\s]+\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(t)) return "";
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

function shortRailPath(path: string, title?: string): string {
  return shortPath(path, 2, title);
}

function hubAssetUrl(src: string, noteId: string): string | null {
  const raw = (src || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  const origin = apiOrigin();
  try {
    const base = typeof window !== "undefined" ? window.location.origin : origin;
    const absolute = raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/");
    if (absolute) {
      const u = new URL(raw, base);
      const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      const same = u.origin === base || u.origin === origin || u.origin === "null";
      if (u.pathname.startsWith("/v1/") && (same || loopback)) {
        const q = new URLSearchParams(u.search);
        q.delete("token");
        const search = q.toString();
        return `${origin}${u.pathname}${search ? `?${search}` : ""}`;
      }
      return null;
    }
  } catch {
    /* relative */
  }
  const rel = raw.replace(/^\.\//, "");
  return `${origin}/v1/notes/${noteId}/assets?path=${encodeURIComponent(rel)}`;
}

function appendToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}token=${encodeURIComponent(token)}`;
  }
}

/** Rewrite /v1 and relative assets/... media src to an absolute API URL with ?token=. */
function rewritePreviewHtmlForIframe(html: string, noteId: string, token: string | null): string {
  const rewriteSrc = (src: string): string => {
    const target = hubAssetUrl(src, noteId);
    if (!target) return src;
    return appendToken(target, token);
  };
  let body = html;
  const mediaTags = "img|audio|video|source";
  body = body.replace(
    new RegExp(`(<(?:${mediaTags})\\b[^>]*\\ssrc=")([^"]+)(")`, "gi"),
    (_a, pre: string, src: string, post: string) => `${pre}${rewriteSrc(src)}${post}`,
  );
  body = body.replace(
    /(<video\b[^>]*\sposter=")([^"]+)(")/gi,
    (_a, pre: string, src: string, post: string) => `${pre}${rewriteSrc(src)}${post}`,
  );
  body = body.replace(
    /(url\()(['"]?)([^'")]+)(\2\))/gi,
    (_a, pre: string, q: string, src: string, post: string) => {
      if (/^(https?:|data:|blob:)/i.test(src) && !/\/v1\//.test(src) && !/assets\//i.test(src)) {
        return `${pre}${q}${src}${post}`;
      }
      return `${pre}${q}${rewriteSrc(src)}${post}`;
    },
  );
  return body;
}

/** Stamp parent hub theme onto preview HTML so iframe CSS follows 墨夜/素白. */
function withPreviewTheme(html: string, theme: HubTheme): string {
  return html.replace(/<html\b([^>]*)>/i, (_m, attrs: string) => {
    const cleaned = String(attrs).replace(/\s*data-theme=(["']).*?\1/i, "");
    if (theme === "matcha") return `<html${cleaned}>`;
    return `<html${cleaned} data-theme="${theme}">`;
  });
}

function currentHubTheme(): HubTheme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "ink" || attr === "plain") return attr;
  }
  try {
    return readCachedTheme().theme;
  } catch {
    return "matcha";
  }
}

function markBrokenMedia(el: Element, kind: string): void {
  el.setAttribute("data-nh-broken", "1");
  if (el instanceof HTMLImageElement) {
    el.alt = el.alt || "图片加载失败";
    el.style.outline = "1px dashed #c45";
    el.style.minHeight = "2.5rem";
    el.style.background = "rgba(196,69,85,0.08)";
  } else {
    const tip = el.ownerDocument.createElement("div");
    tip.className = "nh-broken-media";
    tip.textContent = `${kind}加载失败`;
    tip.setAttribute(
      "style",
      "margin:0.5rem 0;padding:0.5rem 0.75rem;border:1px dashed #c45;border-radius:8px;color:#8a3a3a;font-size:0.85rem;background:rgba(196,69,85,0.06)",
    );
    el.parentElement?.insertBefore(tip, el.nextSibling);
  }
}


function scrollPreviewToHash(doc: Document | null | undefined, hash = typeof location !== "undefined" ? location.hash : "") {
  if (!doc || !hash || hash === "#") return false;
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!id) return false;
  const el = doc.getElementById(id);
  if (!el) return false;
  doc.querySelectorAll("section.nh-block.is-jump-target").forEach((n) => n.classList.remove("is-jump-target"));
  el.classList.add("is-jump-target");
  el.scrollIntoView({ block: "start", behavior: "auto" });
  return true;
}

async function scrollPreviewToHashWhenReady(doc: Document, hash = location.hash) {
  if (!hash || hash === "#") return;
  const tryOnce = () => scrollPreviewToHash(doc, hash);
  if (tryOnce()) {
    // Re-run after images settle so layout shift does not leave the block off-screen.
    const imgs = [...doc.images];
    if (imgs.length) {
      await Promise.all(
        imgs.map(
          (img) =>
            img.complete
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  img.addEventListener("load", () => resolve(), { once: true });
                  img.addEventListener("error", () => resolve(), { once: true });
                }),
        ),
      );
      tryOnce();
    }
    requestAnimationFrame(() => tryOnce());
    setTimeout(() => tryOnce(), 320);
    return;
  }
  // Element may appear after srcdoc paint — retry briefly.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 80));
    if (tryOnce()) {
      setTimeout(() => tryOnce(), 320);
      return;
    }
  }
}

async function hydrateOne(
  el: Element,
  attr: "src" | "poster",
  noteId: string,
  token: string | null,
  blobs: string[],
  auth: HeadersInit,
  kind: string,
): Promise<void> {
  const src = el.getAttribute(attr) || "";
  const target = hubAssetUrl(src, noteId);
  if (!target) return;
  try {
    const res = await fetch(target, { headers: auth, credentials: "include" });
    if (!res.ok) {
      markBrokenMedia(el, kind);
      return;
    }
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    blobs.push(obj);
    el.setAttribute(attr, obj);
  } catch {
    markBrokenMedia(el, kind);
  }
}

async function hydratePreviewAssets(doc: Document, noteId: string, token: string | null, blobs: string[]): Promise<void> {
  const auth: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
  const jobs: Promise<void>[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    jobs.push(hydrateOne(img, "src", noteId, token, blobs, auth, "图片"));
  }
  for (const audio of Array.from(doc.querySelectorAll("audio"))) {
    jobs.push(hydrateOne(audio, "src", noteId, token, blobs, auth, "音频"));
  }
  for (const video of Array.from(doc.querySelectorAll("video"))) {
    jobs.push(hydrateOne(video, "src", noteId, token, blobs, auth, "视频"));
    if (video.getAttribute("poster")) {
      jobs.push(hydrateOne(video, "poster", noteId, token, blobs, auth, "封面"));
    }
  }
  for (const source of Array.from(doc.querySelectorAll("source"))) {
    jobs.push(hydrateOne(source, "src", noteId, token, blobs, auth, "媒体"));
  }
  const styled = Array.from(doc.querySelectorAll<HTMLElement>("[style]"));
  for (const el of styled) {
    const st = el.getAttribute("style") || "";
    const m = /url\((['"]?)([^'")]+)\1\)/i.exec(st);
    if (!m) continue;
    const target = hubAssetUrl(m[2], noteId);
    if (!target) continue;
    jobs.push(
      (async () => {
        try {
          const res = await fetch(target, { headers: auth, credentials: "include" });
          if (!res.ok) return;
          const blob = await res.blob();
          const obj = URL.createObjectURL(blob);
          blobs.push(obj);
          el.style.backgroundImage = `url("${obj}")`;
        } catch {
          /* keep */
        }
      })(),
    );
  }
  await Promise.all(jobs);
}

export default function NotePreviewPage() {
  const params = useParams<{ id: string }>();
  const ref = useRef<HTMLIFrameElement>(null);
  const blobsRef = useRef<string[]>([]);
  const reduced = useReducedMotion();
  const [srcDoc, setSrcDoc] = useState("");
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [book, setBook] = useState<{ id: string; name: string; source: string } | null>(null);
  const [pathNames, setPathNames] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<{
    title: string;
    path: string;
    space_id: string;
    connection_id: string;
    icon?: string | null;
    acl: { visibility: "space" | "owners" | "members"; user_ids: string[]; visible_in_space: boolean };
    can_patch_acl: boolean;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  const [previewErr, setPreviewErr] = useState("");
  const [previewReady, setPreviewReady] = useState(false);
  const [headStuck, setHeadStuck] = useState(false);
  const headSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    const id = params.id;
    const token = getToken();
    const blobs = blobsRef.current;
    let cancelled = false;
    setPreviewReady(false);
    setPreviewErr("");
    setSrcDoc("");
    fetch(`${apiOrigin()}/v1/notes/${id}/preview`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    })
      .then(async (r) => {
        const html = await r.text();
        if (cancelled) return;
        const hubChrome = /id=["']__next["']/.test(html) || /class=["'][^"']*rail[^"']*["']/.test(html);
        const isPreview = /<article\b/i.test(html) || /data-preview-style=/.test(html);
        if (!r.ok || hubChrome || !isPreview) {
          setPreviewErr("预览暂时无法打开。可以回书架再试一次。");
          setSrcDoc("");
          setPreviewReady(true);
          return;
        }
        const rewritten = withPreviewTheme(rewritePreviewHtmlForIframe(html, id, token), currentHubTheme());
        setPreviewErr("");
        setSrcDoc(rewritten);
        setPreviewReady(true);
        const iframe = ref.current;
        if (iframe) iframe.srcdoc = rewritten;
        const doc = iframe?.contentDocument;
        if (doc) {
          await hydratePreviewAssets(doc, id, token, blobs);
          await scrollPreviewToHashWhenReady(doc, location.hash);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewErr("预览暂时无法打开。可以回书架再试一次。");
          setPreviewReady(true);
        }
      });
    api<{ similar?: SimilarHit[] }>(`/v1/notes/${id}/similar`)
      .then((out) => setSimilar(out.similar ?? []))
      .catch(() => setSimilar([]));
    api<{
      note?: {
        title: string;
        path: string;
        space_id: string;
        connection_id: string;
        frontmatter?: Record<string, unknown> | null;
        acl?: { visibility: "space" | "owners" | "members"; user_ids: string[]; visible_in_space: boolean };
      };
      can_patch_acl?: boolean;
    }>(`/v1/notes/${id}`)
      .then((out) => {
        if (out.note) {
          setMissing(false);
          const rawIcon = out.note.frontmatter?.icon;
          const icon =
            typeof rawIcon === "string" && rawIcon.trim()
              ? siyuanIconToEmoji(rawIcon.trim()) || null
              : null;
          setMeta({
            title: out.note.title,
            path: out.note.path,
            space_id: out.note.space_id,
            connection_id: out.note.connection_id,
            icon,
            acl: out.note.acl ?? { visibility: "space", user_ids: [], visible_in_space: true },
            can_patch_acl: Boolean(out.can_patch_acl),
          });
          const note = out.note;
          api<{ connections: { id: string; name: string; source: string }[] }>(
            `/v1/spaces/${note.space_id}/connections`,
          )
            .then((conns) => {
              const hit = conns.connections.find((x) => x.id === note.connection_id);
              if (hit) setBook({ id: hit.id, name: hit.name, source: hit.source });
            })
            .catch(() => setBook(null));
        } else {
          setMissing(true);
        }
      })
      .catch(() => {
        setMeta(null);
        setMissing(true);
      });
    return () => {
      cancelled = true;
      for (const u of blobsRef.current) URL.revokeObjectURL(u);
      blobsRef.current = [];
    };
  }, [params.id]);

  // Keep iframe paper in sync when user switches 抹茶 / 墨夜 / 素白.
  useEffect(() => {
    const apply = (theme: HubTheme) => {
      setSrcDoc((prev) => {
        if (!prev) return prev;
        const next = withPreviewTheme(prev, theme);
        if (next === prev) return prev;
        const iframe = ref.current;
        if (iframe) iframe.srcdoc = next;
        return next;
      });
    };
    apply(currentHubTheme());
    return subscribeTheme((s) => apply(s.theme));
  }, []);

  useEffect(() => {
    if (!meta || !book) return;
    const ancestors = pathCrumbs(meta.path).slice(0, -1);
    if (!ancestors.length) return;
    const parents = ancestors.map((c, i) => (i === 0 ? "" : ancestors[i - 1].path)).slice(0, 6);
    let dead = false;
    Promise.all(
      parents.map((parent) =>
        api<{ tree?: { name: string; path: string }[] }>(
          `/v1/spaces/${meta.space_id}/tree?connection_id=${encodeURIComponent(book.id)}${
            parent ? `&parent=${encodeURIComponent(parent)}` : ""
          }`,
        )
          .then((r) => r.tree ?? [])
          .catch(() => []),
      ),
    ).then((levels) => {
      if (dead) return;
      const map: Record<string, string> = {};
      for (const level of levels) {
        for (const node of level) {
          if (!node?.path || !node?.name) continue;
          map[node.path] = node.name;
          const seg = tailSeg(node.path).replace(/\.sy$/i, "");
          if (seg && !map[seg]) map[seg] = node.name;
        }
      }
      setPathNames((prev) => ({ ...prev, ...map }));
    });
    const notebook = ancestors[0]?.path ?? "";
    const q = new URLSearchParams({ connection_id: book.id });
    if (notebook) q.set("path", notebook);
    void api<{ notes?: { path: string; title: string; source_id?: string }[] }>(
      `/v1/spaces/${meta.space_id}/notes?${q}`,
    )
      .then((r) => {
        if (dead) return;
        const extra = titlesFromNotes(r.notes ?? []);
        if (Object.keys(extra).length) setPathNames((prev) => ({ ...extra, ...prev }));
      })
      .catch(() => {
        /* titles stay from the tree */
      });
    return () => {
      dead = true;
    };
  }, [meta, book]);

  useEffect(() => {
    const el = headSentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setHeadStuck(!entry.isIntersecting), {
      threshold: 0,
      rootMargin: "-1px 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [missing]);

  if (missing) {
    return (
      <div className="note-desk note-desk-empty">
        <h1>找不到这篇</h1>
        <p className="muted">也许它还没同步进来，或只给空间里的一部分人看。</p>
        <p>
          <Link className="note-desk-back" href="/notes">
            回书架
          </Link>
        </p>
      </div>
    );
  }

  const title = decodeSegment(meta?.title || "") || "这篇笔记";

  return (
    <article className="note-desk">
      <div className="note-desk-sentinel" ref={headSentinelRef} aria-hidden="true" />
      <header className={`note-desk-head${headStuck ? " is-stuck" : ""}`}>
        {(() => {
          const ancestors = meta?.path
            ? trailWithoutBookPrefix(
                resolveCrumbs(pathCrumbs(meta.path), pathNames, meta.title),
                book?.name ?? "",
              ).slice(0, -1)
            : [];
          const parentCrumb = ancestors.length ? ancestors[ancestors.length - 1] : null;
          const parentHref = book
            ? parentCrumb
              ? `/notes?book=${encodeURIComponent(book.id)}&path=${encodeURIComponent(parentCrumb.path)}`
              : `/notes?book=${encodeURIComponent(book.id)}`
            : "/notes";
          return (
            <div className="note-desk-nav">
              <Link className="note-desk-back" href={parentHref} title={parentCrumb ? `返回 ${parentCrumb.label}` : book ? `返回 ${book.name}` : "返回书架"}>
                返回
              </Link>
            </div>
          );
        })()}
        {meta?.path && (
          <PathTrail
            items={[
              { key: "shelf", label: "书架", title: "回到书架", href: "/notes", root: true },
              ...(book
                ? [
                    {
                      key: "book",
                      label: book.name,
                      title: `${bookSourceLabel(book.source)} · ${book.name}`,
                      href: `/notes?book=${encodeURIComponent(book.id)}`,
                    } as TrailItem,
                  ]
                : []),
              ...trailWithoutBookPrefix(
                  resolveCrumbs(pathCrumbs(meta.path), pathNames, meta.title),
                  book?.name ?? "",
                )
                .slice(0, -1)
                .map<TrailItem>((c) => ({
                  key: c.path,
                  label: c.label,
                  title: prettyPath(c.path, c.label) || c.label,
                  href: book
                    ? `/notes?book=${encodeURIComponent(book.id)}&path=${encodeURIComponent(c.path)}`
                    : "/notes",
                })),
            ]}
            current={
              decodeSegment(meta.title) ||
              (isIdSegment(pathCrumbs(meta.path).slice(-1)[0]?.label ?? "")
                ? ""
                : pathCrumbs(meta.path).slice(-1)[0]?.label) ||
              "笔记"
            }
            currentTitle={prettyPath(meta.path, meta.title) || decodeSegment(meta.title)}
          />
        )}
        <div className="note-desk-title-row">
          <h1 className="note-desk-title">
            {meta?.icon ? (
              <span className="note-desk-title-icon" aria-hidden="true">
                {meta.icon}
              </span>
            ) : null}
            {title}
          </h1>
          {book && <SourceBadge source={book.source} />}
        </div>
        {book ? <p className="note-desk-meta muted">{book.name}</p> : null}
        {meta && (
          <NoteWho
            noteId={params.id}
            spaceId={meta.space_id}
            acl={meta.acl}
            canPatch={meta.can_patch_acl}
          />
        )}
      </header>

      <div className={`note-desk-body${similar.length > 0 ? " has-rail" : ""}`}>
        <motion.div
          className="note-desk-canvas"
          initial={reduced ? false : { opacity: 0.92, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: easeOutExpo }}
        >
          {!previewReady && !previewErr && (
            <div className="note-desk-loading" aria-busy="true" aria-label="正在铺开这篇笔记">
              <span />
              <span />
              <span />
              <span />
            </div>
          )}
          {previewErr && (
            <div className="note-desk-error" role="alert">
              <p>{previewErr}</p>
              <Link href="/notes">回书架</Link>
            </div>
          )}
          {!previewErr && (
            <iframe
              className={`note-desk-frame${previewReady && srcDoc ? " is-ready" : ""}`}
              ref={ref}
              title={title}
              srcDoc={srcDoc}
              onLoad={() => {
                const doc = ref.current?.contentDocument;
                if (!doc) return;
                const token = getToken();
                const id = params.id;
                void hydratePreviewAssets(doc, id, token, blobsRef.current).then(() =>
                  scrollPreviewToHashWhenReady(doc, location.hash),
                );
              }}
            />
          )}
        </motion.div>

        {similar.length > 0 && (
          <aside className="note-desk-rail" aria-label="相近笔记">
            <h2>相近笔记</h2>
            <ul>
              {similar.map((h) => {
                const pathLabel = shortRailPath(h.path, h.title);
                const quietPath = pathLabel && !isIdSegment(pathLabel) ? pathLabel : "";
                const snip = stripRailSnippet(h.snippet || "");
                return (
                <li key={h.note_id}>
                  <Link href={h.preview_url || `/notes/${h.note_id}`}>
                    <span className="note-rail-title">{decodeSegment(h.title) || "未命名"}</span>
                    {snip ? <span className="note-rail-snip">{snip}</span> : null}
                    {quietPath ? <span className="note-rail-path">{quietPath}</span> : null}
                  </Link>
                </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>
    </article>
  );
}
