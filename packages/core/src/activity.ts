export type ActivityDay = {
  date: string;
  notes: number;
  upserts?: number;
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

function toCountMap(
  rows: Record<string, number> | { date: string; notes?: number; upserts?: number }[] | undefined,
  field: "notes" | "upserts",
): Record<string, number> {
  if (!rows) return {};
  if (!Array.isArray(rows)) return { ...rows };
  const out: Record<string, number> = {};
  for (const r of rows) {
    const n = Number(r[field] ?? 0);
    if (!r.date) continue;
    out[r.date] = (out[r.date] ?? 0) + (Number.isFinite(n) ? n : 0);
  }
  return out;
}

/** Fill every day in `[today-(days-1), today]` (Asia/Shanghai) with note/upsert counts. */
export function buildActivitySeries(opts: {
  days: number;
  now?: Date;
  notes?: Record<string, number> | { date: string; notes: number }[];
  upserts?: Record<string, number> | { date: string; upserts: number }[];
}): ActivityDay[] {
  const n = Math.max(1, Math.min(366, Math.floor(opts.days) || 365));
  const today = shanghaiYmd(opts.now ?? new Date());
  const start = addYmd(today, -(n - 1));
  const noteMap = toCountMap(opts.notes, "notes");
  const upMap = toCountMap(opts.upserts, "upserts");
  const out: ActivityDay[] = [];
  for (let i = 0; i < n; i++) {
    const date = addYmd(start, i);
    out.push({ date, notes: noteMap[date] ?? 0, upserts: upMap[date] ?? 0 });
  }
  return out;
}
