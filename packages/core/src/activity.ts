export type ActivityDay = {
  date: string;
  /** Notes with source_updated_at on this day (secondary). */
  notes: number;
  /** Sum of markdown character lengths for those notes — primary intensity signal. */
  chars: number;
  /** Sum of block counts for those notes. */
  blocks: number;
  /** @deprecated Hub sync upserts; kept optional for older clients. */
  upserts?: number;
};

export type ActivityYear = {
  year: number;
  days: ActivityDay[];
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Civil YYYY-MM-DD in Asia/Shanghai. */
export function shanghaiYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Add days to a timezone-less YYYY-MM-DD. */
export function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days);
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
}

/** Sunday = 0 … Saturday = 6, treating YYYY-MM-DD as a civil date. */
export function weekdaySun0(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: string): boolean {
  if (!YMD_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

type DayRow = {
  date: string;
  notes?: number;
  chars?: number;
  blocks?: number;
  upserts?: number;
};

function toFieldMap(
  rows: Record<string, number> | DayRow[] | undefined,
  field: "notes" | "chars" | "blocks" | "upserts",
): Record<string, number> {
  if (!rows) return {};
  if (!Array.isArray(rows)) return { ...rows };
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.date) continue;
    const n = Number(r[field] ?? 0);
    out[r.date] = (out[r.date] ?? 0) + (Number.isFinite(n) ? n : 0);
  }
  return out;
}

function fillRange(
  from: string,
  to: string,
  notes: Record<string, number>,
  chars: Record<string, number>,
  blocks: Record<string, number>,
  upserts: Record<string, number>,
): ActivityDay[] {
  if (from > to) return [];
  const out: ActivityDay[] = [];
  for (let date = from; date <= to; date = addYmd(date, 1)) {
    out.push({
      date,
      notes: notes[date] ?? 0,
      chars: chars[date] ?? 0,
      blocks: blocks[date] ?? 0,
      upserts: upserts[date] ?? 0,
    });
  }
  return out;
}

function mapsFromOpts(opts: {
  notes?: Record<string, number> | DayRow[];
  chars?: Record<string, number> | DayRow[];
  blocks?: Record<string, number> | DayRow[];
  upserts?: Record<string, number> | DayRow[];
  /** When rows already carry chars/blocks/notes, pass them once via `rows`. */
  rows?: DayRow[];
}) {
  if (opts.rows) {
    return {
      notes: toFieldMap(opts.rows, "notes"),
      chars: toFieldMap(opts.rows, "chars"),
      blocks: toFieldMap(opts.rows, "blocks"),
      upserts: toFieldMap(opts.rows, "upserts"),
    };
  }
  return {
    notes: toFieldMap(opts.notes, "notes"),
    chars: toFieldMap(opts.chars ?? opts.notes, "chars"),
    blocks: toFieldMap(opts.blocks ?? opts.notes, "blocks"),
    upserts: toFieldMap(opts.upserts, "upserts"),
  };
}

/** Fill every day in `[today-(days-1), today]` (Asia/Shanghai). */
export function buildActivitySeries(opts: {
  days: number;
  now?: Date;
  notes?: Record<string, number> | DayRow[];
  chars?: Record<string, number> | DayRow[];
  blocks?: Record<string, number> | DayRow[];
  upserts?: Record<string, number> | DayRow[];
  rows?: DayRow[];
}): ActivityDay[] {
  const n = Math.max(1, Math.min(366, Math.floor(opts.days) || 365));
  const today = shanghaiYmd(opts.now ?? new Date());
  const start = addYmd(today, -(n - 1));
  const m = mapsFromOpts(opts);
  return fillRange(start, today, m.notes, m.chars, m.blocks, m.upserts);
}

/**
 * Fill every civil day in `[from, to]` inclusive (max ~10 years).
 * Dates are timezone-less YYYY-MM-DD strings.
 */
export function buildActivityRange(opts: {
  from: string;
  to: string;
  maxDays?: number;
  notes?: Record<string, number> | DayRow[];
  chars?: Record<string, number> | DayRow[];
  blocks?: Record<string, number> | DayRow[];
  upserts?: Record<string, number> | DayRow[];
  rows?: DayRow[];
}): ActivityDay[] {
  if (!isYmd(opts.from) || !isYmd(opts.to)) return [];
  let from = opts.from;
  let to = opts.to;
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  const maxDays = Math.max(1, Math.min(3660, Math.floor(opts.maxDays ?? 3660)));
  const span = (() => {
    let n = 0;
    for (let d = from; d <= to; d = addYmd(d, 1)) n++;
    return n;
  })();
  if (span > maxDays) from = addYmd(to, -(maxDays - 1));
  const m = mapsFromOpts(opts);
  return fillRange(from, to, m.notes, m.chars, m.blocks, m.upserts);
}

/** Group a flat day series into calendar years; each year is Jan 1 … Dec 31 (zeros filled). */
export function groupActivityByYear(
  days: ActivityDay[],
  opts?: { fromYear?: number; toYear?: number },
): ActivityYear[] {
  const notes: Record<string, number> = {};
  const chars: Record<string, number> = {};
  const blocks: Record<string, number> = {};
  const upserts: Record<string, number> = {};
  for (const d of days) {
    notes[d.date] = d.notes;
    chars[d.date] = d.chars;
    blocks[d.date] = d.blocks;
    upserts[d.date] = d.upserts ?? 0;
  }
  let fromYear = opts?.fromYear;
  let toYear = opts?.toYear;
  if (fromYear == null || toYear == null) {
    for (const d of days) {
      const y = Number(d.date.slice(0, 4));
      if (!Number.isFinite(y)) continue;
      if (fromYear == null || y < fromYear) fromYear = y;
      if (toYear == null || y > toYear) toYear = y;
    }
  }
  if (fromYear == null || toYear == null) return [];
  const years: ActivityYear[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    years.push({ year: y, days: fillRange(from, to, notes, chars, blocks, upserts) });
  }
  return years;
}
