import type { GrowthKind, HostGrowthEvent, HostNote } from "./types.ts";

const SECTION: { kind: GrowthKind; heading: string }[] = [
  { kind: "goal", heading: "目标" },
  { kind: "habit", heading: "习惯" },
  { kind: "mood", heading: "心情" },
  { kind: "review", heading: "复盘" },
  { kind: "focus", heading: "专注" },
];

export function onAskMentionsGrowth(query: string): boolean {
  return /成长|周报|目标|习惯/.test(query);
}

export function eventTitle(event: HostGrowthEvent, notes: Map<string, HostNote>): string {
  const payloadTitle = event.payload && typeof event.payload.title === "string" ? event.payload.title.trim() : "";
  if (payloadTitle) return payloadTitle;
  if (event.note_id) {
    const n = notes.get(event.note_id);
    if (n?.title) return n.title;
  }
  return event.kind;
}

export function renderWeeklyReport(opts: {
  from: string;
  to: string;
  events: HostGrowthEvent[];
  notes?: HostNote[];
  excluded?: { ids?: string[]; paths?: string[] };
}): string {
  const notes = new Map((opts.notes ?? []).map((n) => [n.id, n]));
  const lines: string[] = [
    `# 成长周报（${opts.from} ~ ${opts.to}）`,
    "",
    "中枢只读，本报告不写回任何源。仅个人空间。",
    "",
  ];
  const exclPaths = (opts.excluded?.paths ?? []).filter(Boolean);
  const exclIds = (opts.excluded?.ids ?? []).filter(Boolean);
  if (exclPaths.length || exclIds.length) {
    const bits: string[] = [];
    if (exclPaths.length) bits.push(`路径/标题含 ${exclPaths.map((p) => `「${p}」`).join("、")}`);
    if (exclIds.length) bits.push(`已勾选 ${exclIds.length} 篇笔记`);
    lines.push(`> 已排除：${bits.join("；")}。`);
    lines.push("");
  }
  for (const sec of SECTION) {
    lines.push(`## ${sec.heading}`);
    const items = opts.events.filter((e) => e.kind === sec.kind);
    if (!items.length) {
      lines.push("本时段暂无。");
      lines.push("");
      continue;
    }
    for (const e of items) {
      const title = eventTitle(e, notes);
      const day = e.happened_at.slice(0, 10);
      if (e.note_id) {
        lines.push(`- [${title}](/notes/${e.note_id})（${day}）`);
      } else {
        lines.push(`- ${title}（${day}）`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export function shortGrowthSummary(events: HostGrowthEvent[]): string {
  const count = (k: GrowthKind) => events.filter((e) => e.kind === k).length;
  const parts = [
    `目标 ${count("goal")} 条`,
    `习惯 ${count("habit")} 条`,
    `心情 ${count("mood")} 条`,
    `复盘 ${count("review")} 条`,
  ];
  if (!events.length) return "近期个人空间暂无成长事件。";
  return `成长摘要：${parts.join("，")}。`;
}

export function shanghaiYmd(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

export function lastSevenDayRange(now = new Date()): { from: string; to: string } {
  const to = shanghaiYmd(now);
  const start = new Date(now.getTime() + 8 * 3600 * 1000 - 6 * 24 * 3600 * 1000);
  const from = start.toISOString().slice(0, 10);
  return { from, to };
}

/** Inclusive range ending today (Shanghai) spanning the last `days` calendar days. */
export function lastNDayRange(days: number, now = new Date()): { from: string; to: string } {
  const n = Math.max(1, Math.min(366, Math.floor(days) || 7));
  const to = shanghaiYmd(now);
  const start = new Date(now.getTime() + 8 * 3600 * 1000 - (n - 1) * 24 * 3600 * 1000);
  const from = start.toISOString().slice(0, 10);
  return { from, to };
}
