"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type HeatDay = {
  date: string;
  notes: number;
  chars?: number;
  blocks?: number;
  upserts?: number;
};
export type HeatYear = { year: number; days: HeatDay[] };

function weekdaySun0(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** Primary tooltip: 月日 · 字 · 块; notes as secondary when > 0. */
function tooltip(day: HeatDay): string {
  const [, m, d] = day.date.split("-");
  const chars = day.chars ?? 0;
  const blocks = day.blocks ?? 0;
  let s = `${Number(m)}月${Number(d)}日 · ${fmtNum(chars)} 字 · ${fmtNum(blocks)} 块`;
  if (day.notes > 0) s += ` · ${day.notes} 篇`;
  return s;
}

/** Heat intensity driven by 字数 (chars). */
function level(chars: number, max: number): number {
  if (chars <= 0 || max <= 0) return 0;
  const t = chars / max;
  if (t > 0.75) return 4;
  if (t > 0.5) return 3;
  if (t > 0.25) return 2;
  return 1;
}

function shanghaiYear(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
    }).format(now),
  );
}

function emptyYear(year: number): HeatYear {
  const days: HeatDay[] = [];
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year, 11, 31);
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    days.push({ date: ymd, notes: 0, chars: 0, blocks: 0 });
  }
  return { year, days };
}

function HeatGrid({
  days,
  selected,
  onSelect,
}: {
  days: HeatDay[];
  selected: string | null;
  onSelect: (day: HeatDay | null) => void;
}) {
  if (!days.length) return null;
  const max = Math.max(0, ...days.map((d) => d.chars ?? 0));
  const pad = weekdaySun0(days[0]!.date);
  const cells: (HeatDay | null)[] = [];
  for (let i = 0; i < pad; i++) cells.push(null);
  cells.push(...days);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="heat-grid" role="img" aria-label="笔记更新热力图（全源，按源文件日期，强度按字数）">
      {cells.map((day, i) => {
        if (!day) {
          return <span key={`e-${i}`} className="heat-cell empty" style={{ ["--i" as string]: i }} />;
        }
        const lv = level(day.chars ?? 0, max);
        const on = selected === day.date;
        return (
          <button
            key={day.date}
            type="button"
            className={`heat-cell lv${lv}${on ? " selected" : ""}`}
            style={{ ["--i" as string]: i }}
            title={tooltip(day)}
            aria-label={tooltip(day)}
            aria-pressed={on}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(on ? null : day);
            }}
          />
        );
      })}
    </div>
  );
}

type Props = {
  days?: HeatDay[];
  years?: HeatYear[];
};

export function Heatmap({ days, years: yearsProp }: Props) {
  const years = useMemo(() => {
    if (yearsProp && yearsProp.length) {
      return [...yearsProp].sort((a, b) => a.year - b.year);
    }
    if (days?.length) {
      const byYear = new Map<number, HeatDay[]>();
      for (const d of days) {
        const y = Number(d.date.slice(0, 4));
        if (!Number.isFinite(y)) continue;
        const list = byYear.get(y) ?? [];
        list.push(d);
        byYear.set(y, list);
      }
      const out: HeatYear[] = [];
      for (const [year, list] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
        const full = emptyYear(year);
        const map = new Map(list.map((d) => [d.date, d]));
        out.push({
          year,
          days: full.days.map((d) => map.get(d.date) ?? d),
        });
      }
      return out;
    }
    return [] as HeatYear[];
  }, [days, yearsProp]);

  const currentYear = shanghaiYear();
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<HeatDay | null>(null);
  const seededKeyRef = useRef<string>("");
  const yearKey = years.map((y) => y.year).join(",");

  useEffect(() => {
    // Seed default year when the set of years first arrives or changes (space switch).
    // Poll refreshes keep the same yearKey so manual selection is preserved.
    if (!years.length) return;
    if (seededKeyRef.current === yearKey) return;
    const curIdx = years.findIndex((y) => y.year === currentYear);
    setIndex(curIdx >= 0 ? curIdx : years.length - 1);
    seededKeyRef.current = yearKey;
  }, [years, currentYear, yearKey]);

  const displayYears = years.length ? years : [emptyYear(currentYear)];
  const displayIndex = years.length ? Math.min(Math.max(0, index), years.length - 1) : 0;
  const canPrev = displayIndex > 0;
  const canNext = displayIndex < displayYears.length - 1;
  const shown = displayYears[displayIndex]!;

  const go = useCallback(
    (dir: -1 | 1) => {
      setIndex((i) => {
        const next = i + dir;
        if (next < 0 || next >= displayYears.length) return i;
        return next;
      });
      setPicked(null);
    },
    [displayYears.length],
  );

  const dragRef = useRef<{ x: number; y: number; active: boolean; moved: boolean } | null>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "Escape") {
      setPicked(null);
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't start year-swipe when pressing a cell button
    if ((e.target as HTMLElement).closest?.(".heat-cell")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, active: true, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    if (Math.abs(e.clientX - drag.x) > 12 || Math.abs(e.clientY - drag.y) > 12) {
      drag.moved = true;
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.active || !drag.moved) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) go(1);
    else go(-1);
  };

  if (!displayYears.length && !days?.length) return null;

  return (
    <div
      className="heat-wrap"
      tabIndex={0}
      role="region"
      aria-roledescription="carousel"
      aria-label="按年活动热力图"
      onKeyDown={onKeyDown}
    >
      <div className="heat-head">
        <h2>活动</h2>
        <div className="heat-year-nav" aria-label="切换年份">
          <button
            type="button"
            className="heat-nav-btn"
            aria-label="上一年"
            disabled={!canPrev}
            onClick={() => go(-1)}
          >
            ‹
          </button>
          <span className="heat-year-label" aria-live="polite">
            {shown.year}
          </span>
          <button
            type="button"
            className="heat-nav-btn"
            aria-label="下一年"
            disabled={!canNext}
            onClick={() => go(1)}
          >
            ›
          </button>
        </div>
      </div>
      <p className="heat-sub">全源 · 按源文件日期 · 强度按字数</p>
      <div
        className="heat-slide"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div className="heat-grid-scroll">
          <HeatGrid
            key={shown.year}
            days={shown.days}
            selected={picked?.date ?? null}
            onSelect={setPicked}
          />
        </div>
      </div>
      {picked && (
        <p className="heat-tip" role="status">
          {tooltip(picked)}
        </p>
      )}
      {displayYears.length > 1 && (
        <div className="heat-dots" role="tablist" aria-label="年份">
          {displayYears.map((y, i) => (
            <button
              key={y.year}
              type="button"
              role="tab"
              aria-selected={i === displayIndex}
              aria-label={`${y.year} 年`}
              className={`heat-dot${i === displayIndex ? " on" : ""}`}
              onClick={() => {
                setIndex(i);
                setPicked(null);
              }}
            />
          ))}
        </div>
      )}
      <div className="heat-legend">
        少
        <i className="heat-cell" />
        <i className="heat-cell lv1" />
        <i className="heat-cell lv2" />
        <i className="heat-cell lv3" />
        <i className="heat-cell lv4" />
        多
      </div>
    </div>
  );
}
