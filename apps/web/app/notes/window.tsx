"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Window a long list: only rows in the viewport (+ overscan) mount.
 * Fixed row height, transform-only positioning, compositor-friendly.
 */
export function WindowList<T>({
  items,
  rowHeight,
  overscan = 12,
  className,
  renderRow,
  scrollToIndex = null,
  role,
  ariaLabel,
  onKeyDown,
  tabIndex,
  style,
}: {
  items: T[];
  rowHeight: number;
  overscan?: number;
  className?: string;
  renderRow: (item: T, index: number) => ReactNode;
  scrollToIndex?: number | null;
  role?: string;
  ariaLabel?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(items.length, 48) });
  const lastScroll = useRef<number | null>(null);
  const rafScroll = useRef(0);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop;
    const h = el.clientHeight || rowHeight * 24;
    const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const end = Math.min(items.length, Math.ceil((top + h) / rowHeight) + overscan);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [items.length, overscan, rowHeight]);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (rafScroll.current) return;
      rafScroll.current = requestAnimationFrame(() => {
        rafScroll.current = 0;
        update();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafScroll.current) cancelAnimationFrame(rafScroll.current);
    };
  }, [update]);

  useEffect(() => {
    update();
  }, [items.length, update]);

  useEffect(() => {
    if (scrollToIndex == null || scrollToIndex < 0) return;
    if (lastScroll.current === scrollToIndex) return;
    const el = ref.current;
    if (!el) return;
    lastScroll.current = scrollToIndex;
    const top = scrollToIndex * rowHeight;
    const viewTop = el.scrollTop;
    const viewBot = viewTop + el.clientHeight;
    if (top < viewTop + rowHeight || top + rowHeight > viewBot - rowHeight) {
      el.scrollTo({ top: Math.max(0, top - Math.min(el.clientHeight * 0.28, 96)) });
    }
  }, [scrollToIndex, rowHeight]);

  const start = Math.min(range.start, items.length);
  const end = Math.min(range.end, items.length);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      className={className}
      style={style}
      role={role}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      data-windowed={items.length}
    >
      <div
        className="window-spacer"
        style={{ height: items.length * rowHeight, position: "relative" }}
      >
        <div
          className="window-slice"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            transform: `translate3d(0, ${start * rowHeight}px, 0)`,
          }}
        >
          {slice.map((item, i) => (
            <Fragment key={start + i}>{renderRow(item, start + i)}</Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
