"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

export type CiteRef = {
  note_id: string;
  block_id: string;
  source_block_id: string;
  title: string;
  quote: string;
  preview_url: string;
  path?: string;
  connection_id?: string;
};

const CITE_RE = /【(\d+)】/g;

/** Split plain text into nodes, turning 【n】 into interactive marks. */
export function splitCiteMarks(
  text: string,
  citations: CiteRef[] | undefined,
  keyPrefix: string,
): ReactNode[] {
  if (!text) return [];
  if (!citations?.length || !/【\d+】/.test(text)) {
    return [text];
  }
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const n = Number(m[1]);
    const cite = n >= 1 && n <= citations.length ? citations[n - 1] : undefined;
    out.push(
      <CitationMark
        key={`${keyPrefix}-c${i++}-${n}`}
        n={n}
        citation={cite}
      />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function citeHref(c: CiteRef): string {
  return (
    c.preview_url ||
    `/notes/${c.note_id}${c.source_block_id ? `#b-${c.source_block_id}` : ""}`
  );
}

/** Pick a highlight span inside quote — prefer a mid-length clause. */
export function highlightSpan(quote: string): { before: string; hit: string; after: string } {
  const q = (quote || "").trim();
  if (!q) return { before: "", hit: "", after: "" };
  if (q.length <= 48) return { before: "", hit: q, after: "" };
  // Prefer first sentence / clause up to ~72 chars
  const cut = q.search(/[。！？；;\n]/);
  if (cut > 12 && cut <= 72) {
    return { before: "", hit: q.slice(0, cut + 1), after: q.slice(cut + 1) };
  }
  const end = Math.min(72, q.length);
  // Avoid cutting mid-word for Latin; for CJK just slice
  return { before: "", hit: q.slice(0, end), after: q.slice(end) };
}

function CitationMark({ n, citation }: { n: number; citation?: CiteRef }) {
  const btnId = useId();
  const popId = `${btnId}-pop`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const popW = Math.min(320, window.innerWidth - pad * 2);
    let left = r.left + r.width / 2 - popW / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
    const below = r.bottom + 8;
    const spaceBelow = window.innerHeight - below;
    const top = spaceBelow < 140 && r.top > 160 ? r.top - 8 : below;
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => place();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  useEffect(() => () => clearClose(), []);

  const label = citation
    ? `来源 ${n}：${citation.title || "未命名"}`
    : `来源 ${n}`;

  const hl = citation ? highlightSpan(citation.quote) : null;
  const popAbove = coords && btnRef.current
    ? coords.top < btnRef.current.getBoundingClientRect().top
    : false;

  return (
    <span className="cite-mark-wrap">
      <button
        ref={btnRef}
        type="button"
        id={btnId}
        className="cite-mark"
        aria-label={label}
        aria-describedby={open ? popId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseEnter={() => {
          clearClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onPointerEnter={() => {
          clearClose();
          setOpen(true);
        }}
        onPointerLeave={scheduleClose}
        onFocus={() => {
          clearClose();
          setOpen(true);
        }}
        onBlur={(e) => {
          if (popRef.current?.contains(e.relatedTarget as Node)) return;
          scheduleClose();
        }}
        onClick={(e) => {
          e.preventDefault();
          clearClose();
          setOpen(true);
        }}
      >
        <sup>{n}</sup>
      </button>
      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              id={popId}
              role="dialog"
              aria-label={label}
              className={`cite-pop${popAbove ? " cite-pop-above" : ""}`}
              style={{
                top: popAbove ? undefined : coords.top,
                bottom: popAbove ? window.innerHeight - coords.top : undefined,
                left: coords.left,
                width: Math.min(320, window.innerWidth - 16),
              }}
              onMouseEnter={clearClose}
              onMouseLeave={scheduleClose}
            >
              <div className="cite-pop-head">
                <span className="cite-chip-n" aria-hidden="true">
                  {n}
                </span>
                <strong className="cite-pop-title">
                  {citation?.title || `来源 ${n}`}
                </strong>
              </div>
              {hl && (hl.hit || hl.before || hl.after) ? (
                <p className="cite-pop-quote">
                  {hl.before}
                  <mark className="cite-hl">{hl.hit}</mark>
                  {hl.after}
                </p>
              ) : (
                <p className="cite-pop-quote muted">暂无摘录</p>
              )}
              {citation ? (
                <Link href={citeHref(citation)} className="cite-pop-link" tabIndex={0}>
                  打开原文
                </Link>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
