"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AnimatePresence, easeOutExpo, motion, useReducedMotion } from "../ui-motion";

export type Crumb = {
  /** Display label, already decoded and trimmed. */
  label: string;
  /** Raw path prefix inside the source, used for navigation. */
  path: string;
  /** True when a bilingual title was re-joined from two path segments. */
  merged?: boolean;
};

const ID_SEG = /^\d{14}-[0-9a-z]+$/i;

export const SOURCE_LABEL: Record<string, string> = {
  feishu: "飞书",
  notion: "Notion",
  siyuan: "思源",
  obsidian: "Obsidian",
};

export function bookSourceLabel(source: string): string {
  return SOURCE_LABEL[source] || source || "源";
}

/** Percent escapes and HTML entities never belong in a rendered path. */
const decodeCache = new Map<string, string>();
const crumbsCache = new Map<string, Crumb[]>();
const shortCache = new Map<string, string>();
const prettyCache = new Map<string, string>();
const CACHE_CAP = 8000;

function cacheSet<T>(map: Map<string, T>, key: string, value: T): T {
  if (map.size >= CACHE_CAP) {
    const drop = Math.floor(CACHE_CAP / 4);
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++i >= drop) break;
    }
  }
  map.set(key, value);
  return value;
}

export function decodeSegment(raw: string): string {
  const hit = decodeCache.get(raw);
  if (hit !== undefined) return hit;
  let out = raw;
  if (/%[0-9a-fA-F]{2}/.test(out)) {
    try {
      out = decodeURIComponent(out);
    } catch {
      /* keep the raw text over throwing */
    }
  }
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return cacheSet(decodeCache, raw, out);
}

function prettySegment(raw: string): string {
  const decoded = decodeSegment(raw).replace(/\.sy$/i, "");
  return decoded.trim() || decoded;
}

export function isIdSegment(label: string): boolean {
  // SiYuan doc/block ids: 14-digit timestamp + short hash; .sy leaf suffix is not part of the id.
  const t = label.trim().replace(/\.sy$/i, "");
  if (ID_SEG.test(t)) return true;
  // pathCrumbs may rejoin spaced slashes into "id / id" — still an id wall, not a title.
  if (t.includes(" / ")) {
    return t.split(" / ").every((p) => ID_SEG.test(p.trim().replace(/\.sy$/i, "")));
  }
  return false;
}

/**
 * Split a source path into crumbs.
 * Bilingual titles ("示例知识库 / Wiki samples") arrive split on the slash,
 * so halves padded with spaces are re-joined into the one title they came from.
 */
export function pathCrumbs(raw: string): Crumb[] {
  const hit = crumbsCache.get(raw);
  if (hit) return hit;
  const cleaned = (raw || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) return cacheSet(crumbsCache, raw, []);
  const parts = cleaned.split("/");
  const out: Crumb[] = [];
  let acc = "";
  let prevRaw = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const last = out[out.length - 1];
    const rejoin = Boolean(last) && /\s$/.test(prevRaw) && /^\s/.test(part);
    if (last && rejoin) {
      last.label = `${last.label} / ${prettySegment(part)}`;
      last.path = acc;
      last.merged = true;
    } else if (part.trim() || part) {
      out.push({ label: prettySegment(part), path: acc });
    }
    prevRaw = part;
  }
  return cacheSet(crumbsCache, raw, out.filter((c) => c.label.length > 0));
}

type TreeLike = { name: string; path: string; kind?: string; children?: TreeLike[] | null };

export function tailSeg(path: string): string {
  const bits = path.split("/");
  return bits[bits.length - 1] ?? path;
}

/**
 * Give crumbs the names the source itself uses (notebook titles instead of ids).
 * Walks the loaded tree level by level and matches on the trailing segment, so
 * a node whose stored prefix drifted (id path vs name path) still resolves.
 */
export function labelCrumbsFromTree(tree: TreeLike[] | undefined, crumbs: Crumb[]): Crumb[] {
  let level: TreeLike[] = tree ?? [];
  return crumbs.map((crumb) => {
    const seg = tailSeg(crumb.path);
    const hit =
      level.find((n) => n.path === crumb.path) ??
      level.find((n) => tailSeg(n.path) === seg && n.kind !== "note") ??
      level.find((n) => tailSeg(n.path).replace(/\.sy$/i, "") === seg.replace(/\.sy$/i, ""));
    level = hit?.children ?? [];
    const named = hit ? decodeSegment(hit.name).trim() : "";
    if (!crumb.merged && named && !isIdSegment(named)) return { ...crumb, label: named };
    return crumb;
  });
}

/** Walk a loaded tree and map path / trailing id → human name. */
export function collectPathTitles(
  tree: TreeLike[] | undefined,
  into: Record<string, string> = {},
): Record<string, string> {
  if (!tree) return into;
  for (const n of tree) {
    const name = decodeSegment(n.name ?? "").trim();
    if (name && !isIdSegment(name)) {
      if (n.path) into[n.path] = name;
      const seg = tailSeg(n.path || "").replace(/\.sy$/i, "");
      if (seg) into[seg] = name;
    }
    if (n.children?.length) collectPathTitles(n.children, into);
  }
  return into;
}

/** Map id segments via notes under the same connection (path leaf / source_id → title). */
export function titlesFromNotes(
  notes: { path?: string | null; title?: string | null; source_id?: string | null }[] | undefined,
  into: Record<string, string> = {},
): Record<string, string> {
  if (!notes) return into;
  for (const n of notes) {
    const title = decodeSegment(n.title ?? "").trim();
    if (!title || isIdSegment(title)) continue;
    const path = (n.path ?? "").replace(/\\/g, "/");
    if (path) {
      into[path] = title;
      const seg = tailSeg(path).replace(/\.sy$/i, "");
      if (seg) into[seg] = title;
    }
    const sid = (n.source_id ?? "").trim().replace(/\.sy$/i, "");
    if (sid) into[sid] = title;
  }
  return into;
}

/**
 * Prefer titles mapped from the tree / notes in the same connection.
 * Remaining SiYuan ids are dropped; if nothing human remains, show `fallbackTitle` only.
 */
export function resolveCrumbs(crumbs: Crumb[], titles: Record<string, string>, fallbackTitle?: string): Crumb[] {
  const out: Crumb[] = [];
  for (const c of crumbs) {
    const seg = tailSeg(c.path).replace(/\.sy$/i, "");
    const named = decodeSegment(titles[c.path] ?? titles[seg] ?? "").trim();
    const label = !c.merged && named && !isIdSegment(named) ? named : c.label;
    if (isIdSegment(label)) continue;
    out.push(label === c.label ? c : { ...c, label });
  }
  if (!out.length) {
    const t = decodeSegment(fallbackTitle ?? "").trim();
    if (t && !isIdSegment(t)) {
      out.push({ label: t, path: crumbs.at(-1)?.path ?? "" });
    }
  }
  return out;
}

/** Same, but only the tail: long id chains stop being a wall of text. Never keep bare SiYuan ids. */
export function shortPath(raw: string, keep = 2, title?: string): string {
  const key = `${keep}\0${raw}\0${title ?? ""}`;
  const hit = shortCache.get(key);
  if (hit !== undefined) return hit;
  const crumbs = pathCrumbs(raw).filter((c) => !isIdSegment(c.label));
  let out =
    crumbs.length === 0
      ? ""
      : crumbs.length <= keep
        ? crumbs.map((x) => x.label).join(" / ")
        : `… / ${crumbs.slice(-keep).map((x) => x.label).join(" / ")}`;
  if (!out && title) {
    const t = decodeSegment(title).trim();
    out = t && !isIdSegment(t) ? t : "";
  }
  return cacheSet(shortCache, key, out);
}

/** A path rendered for humans: decoded, trimmed, bilingual titles kept whole. Drops bare SiYuan ids. */
export function prettyPath(raw: string, title?: string): string {
  const key = title ? `${raw}\0${title}` : raw;
  const hit = prettyCache.get(key);
  if (hit !== undefined) return hit;
  const crumbs = pathCrumbs(raw).filter((c) => !isIdSegment(c.label));
  let out = crumbs.length ? crumbs.map((c) => c.label).join(" / ") : "";
  if (!out && title) {
    const t = decodeSegment(title).trim();
    out = t && !isIdSegment(t) ? t : "";
  }
  if (!out) {
    // Last resort: never echo a pure id path; prefer empty over a hash wall.
    const leftover = pathCrumbs(raw).filter((c) => !isIdSegment(c.label));
    out = leftover.length ? leftover.map((c) => c.label).join(" / ") : "";
  }
  return cacheSet(prettyCache, key, out);
}

/** Stable display label for a tree/note name (cached). */
export function displayName(name: string): string {
  return decodeSegment(name).trim() || name;
}

/**
 * Primary list/tree title: never show bare SiYuan id hashes.
 * Resolve via explicit title → titles map (path / leaf id) → human name → parent → 「未命名」.
 */
export function primaryLabel(
  rawName: string,
  opts?: {
    path?: string | null;
    titles?: Record<string, string>;
    title?: string | null;
    parentTitle?: string | null;
    fallback?: string;
  },
): string {
  const fallback = opts?.fallback ?? "未命名";
  const tryHuman = (v: string | null | undefined): string => {
    const t = decodeSegment(v ?? "").trim();
    if (!t || isIdSegment(t)) return "";
    return t;
  };
  const fromTitle = tryHuman(opts?.title);
  if (fromTitle) return fromTitle;

  const titles = opts?.titles;
  const path = (opts?.path ?? "").replace(/\\/g, "/");
  if (titles && path) {
    const hit = tryHuman(titles[path]) || tryHuman(titles[tailSeg(path).replace(/\.sy$/i, "")]);
    if (hit) return hit;
  }

  const decoded = displayName(rawName);
  if (decoded && !isIdSegment(decoded)) return decoded;

  if (titles) {
    const idKey = decoded.replace(/\.sy$/i, "") || rawName.replace(/\.sy$/i, "");
    const byId = tryHuman(titles[idKey]) || tryHuman(titles[rawName]) || tryHuman(titles[decoded]);
    if (byId) return byId;
  }

  const parent = tryHuman(opts?.parentTitle);
  if (parent) return parent;
  return fallback;
}

/** Drop a leading path crumb that repeats the book/connection label already in the trail. */
export function trailWithoutBookPrefix(crumbs: Crumb[], bookName: string): Crumb[] {
  if (!crumbs.length || !bookName) return crumbs;
  const book = displayName(bookName);
  const head = crumbs[0]!;
  if (head.label === book || displayName(head.label) === book) {
    return crumbs.slice(1);
  }
  return crumbs;
}

/**
 * List-row path line: same id→title mapping as PathTrail.
 * Resolves via tree labels + titles map, drops bare SiYuan ids, optionally
 * omits a trailing crumb that repeats the row title.
 */
export function listPathLine(
  raw: string,
  titles: Record<string, string>,
  opts?: {
    title?: string;
    tree?: TreeLike[];
    keep?: number;
    dropTrailingTitle?: boolean;
  },
): string {
  const keep = opts?.keep ?? 3;
  let crumbs = pathCrumbs(raw);
  if (opts?.tree?.length) crumbs = labelCrumbsFromTree(opts.tree, crumbs);
  crumbs = resolveCrumbs(crumbs, titles, opts?.title);
  if (opts?.dropTrailingTitle && opts.title) {
    const t = displayName(opts.title);
    const last = crumbs[crumbs.length - 1];
    if (last && (last.label === t || displayName(last.label) === t)) {
      crumbs = crumbs.slice(0, -1);
    }
  }
  if (!crumbs.length) return "";
  if (crumbs.length <= keep) return crumbs.map((c) => c.label).join(" / ");
  return `… / ${crumbs.slice(-keep).map((c) => c.label).join(" / ")}`;
}


type TrailItem = {
  key: string;
  label: string;
  title?: string;
  /** Click target: a route (href) or an in-page action. */
  href?: string;
  onSelect?: () => void;
  mono?: boolean;
  root?: boolean;
};

function TrailSep() {
  return (
    <span className="trail-sep" aria-hidden="true">
      <svg viewBox="0 0 12 12" fill="none">
        <path d="M4.6 2.6 8 6l-3.4 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Segment({ item }: { item: TrailItem }) {
  const cls = `trail-seg${item.mono ? " is-id" : ""}${item.root ? " is-root" : ""}`;
  if (item.href) {
    return (
      <Link className={cls} href={item.href} title={item.title ?? item.label}>
        {item.label}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={item.onSelect} title={item.title ?? item.label}>
      {item.label}
    </button>
  );
}

/**
 * One breadcrumb trail. Every ancestor is a real control; the current
 * position is inert. Long trails collapse in the middle behind 「…」.
 */
export function PathTrail({
  items,
  current,
  currentTitle,
  label = "路径",
}: {
  items: TrailItem[];
  current: string;
  currentTitle?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const trailKey = useMemo(
    () => `${items.map((i) => i.key).join(">")}|${current}`,
    [items, current],
  );
  // 首段（书架 + 这本书）和末段永远露出来，中间折进「…」
  const collapse = !expanded && items.length > 4;
  const head = collapse ? items.slice(0, 2) : items;
  const tail = collapse ? items.slice(-1) : [];
  const hidden = collapse ? items.slice(2, -1) : [];

  const row = (
    <>
      {head.map((item, i) => (
        <span className="trail-part" key={item.key}>
          {i > 0 ? <TrailSep /> : null}
          <Segment item={item} />
        </span>
      ))}
      {collapse ? (
        <span className="trail-part">
          <TrailSep />
          <button
            type="button"
            className="trail-seg trail-more"
            onClick={() => setExpanded(true)}
            title={hidden.map((h) => h.label).join(" / ")}
            aria-label={`展开中间 ${hidden.length} 层：${hidden.map((h) => h.label).join(" / ")}`}
          >
            …
          </button>
        </span>
      ) : null}
      {tail.map((item) => (
        <span className="trail-part" key={item.key}>
          <TrailSep />
          <Segment item={item} />
        </span>
      ))}
      {current ? (
        <span className="trail-part">
          {items.length ? <TrailSep /> : null}
          <span className="trail-current" title={currentTitle ?? current} aria-current="page">
            {current}
          </span>
        </span>
      ) : null}
    </>
  );

  return (
    <nav className="trail" aria-label={label}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={trailKey}
          className="trail-row"
          initial={reduced ? false : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: 3 }}
          transition={{ duration: 0.16, ease: easeOutExpo }}
        >
          {row}
        </motion.span>
      </AnimatePresence>
    </nav>
  );
}



/**
 * Compact humanized path for lists (search / ask / rails).
 * Decodes, merges bilingual " / " titles, collapses the middle, and
 * drops a trailing pure-id segment when a real title is provided.
 */
export function PathCrumbs({
  path,
  title,
  keep = 3,
}: {
  path: string;
  title?: string;
  keep?: number;
}) {
  const t = title && !isIdSegment(title) ? decodeSegment(title).trim() : "";
  let crumbs = pathCrumbs(path);
  if (title) {
    const last = crumbs[crumbs.length - 1];
    if (last && t && (isIdSegment(last.label) || last.label.replace(/\.sy$/i, "") === t.replace(/\.sy$/i, ""))) {
      // Prefer the note title over a trailing id / duplicate filename crumb.
      if (isIdSegment(last.label)) crumbs = crumbs.slice(0, -1);
    }
  }
  // Never render bare SiYuan id hashes — drop them entirely. Empty → title only.
  crumbs = crumbs.filter((c) => !isIdSegment(c.label));
  if (!crumbs.length) {
    const label = t || "笔记";
    return (
      <div className="muted path-crumbs" title={label}>
        <span>{label}</span>
      </div>
    );
  }
  const full = prettyPath(path, title) || t || crumbs.map((c) => c.label).join(" / ");
  const collapse = crumbs.length > keep;
  const shown = collapse
    ? [{ label: "…", path: "__more__", merged: false as const }, ...crumbs.slice(-keep)]
    : crumbs;
  return (
    <div className="muted path-crumbs" title={full}>
      {shown.map((c, i) => (
        <span key={`${c.path}-${i}`}>
          {i > 0 ? <span aria-hidden="true"> / </span> : null}
          <span>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

export type { TrailItem };
