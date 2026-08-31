import { splitFrontmatter } from "./parse.ts";
import { lastSevenDayRange } from "./report.ts";
import type { HostApi, HostLink, HostNote, SkillHandler, SkillRunResult } from "./types.ts";

export type WritingIsland = { id: string; title: string; path: string };

export type WritingHealthReport = {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  this_week: { notes: number; chars: number; words: number };
  prev_week: { notes: number; chars: number; words: number };
  days_since_last: number | null;
  last_updated_at: string | null;
  islands: WritingIsland[];
  markdown: string;
  summary: string;
};

function asNotes(payload: Record<string, unknown>): HostNote[] {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is HostNote => Boolean(n && typeof n === "object" && "id" in n));
}

export function onAskMentionsWriting(query: string): boolean {
  return /写作|断更|健康度/.test(query);
}

export function countText(markdown: string | null): { chars: number; words: number } {
  const raw = markdown ?? "";
  const { body } = splitFrontmatter(raw);
  const chars = body.replace(/\s+/g, "").length;
  const tokens = body.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  return { chars, words: tokens.length };
}

export function ymdOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function inRange(ymd: string, from: string, to: string): boolean {
  return ymd >= from && ymd <= to;
}

export function islandNotes(notes: HostNote[], links: HostLink[]): HostNote[] {
  const connected = new Set<string>();
  for (const l of links) {
    connected.add(l.from_note_id);
    if (l.to_note_id) connected.add(l.to_note_id);
  }
  return notes.filter((n) => !connected.has(n.id));
}

function tally(notes: HostNote[]): { notes: number; chars: number; words: number } {
  let chars = 0;
  let words = 0;
  for (const n of notes) {
    const c = countText(n.markdown);
    chars += c.chars;
    words += c.words;
  }
  return { notes: notes.length, chars, words };
}

export function computeWritingHealth(
  notes: HostNote[],
  links: HostLink[],
  now = new Date(),
): WritingHealthReport {
  const range = lastSevenDayRange(now);
  const prevTo = addDays(range.from, -1);
  const prevFrom = addDays(prevTo, -6);
  const thisWeek = notes.filter((n) => inRange(ymdOf(n.updated_at), range.from, range.to));
  const prevWeek = notes.filter((n) => inRange(ymdOf(n.updated_at), prevFrom, prevTo));
  const thisStats = tally(thisWeek);
  const prevStats = tally(prevWeek);
  let last: HostNote | null = null;
  for (const n of notes) {
    if (!last || n.updated_at > last.updated_at) last = n;
  }
  let daysSince: number | null = null;
  if (last) {
    const t = new Date(last.updated_at).getTime();
    if (!Number.isNaN(t)) daysSince = Math.max(0, Math.floor((now.getTime() - t) / 86400000));
  }
  const islands = islandNotes(notes, links).map((n) => ({ id: n.id, title: n.title, path: n.path }));
  const deltaChars = thisStats.chars - prevStats.chars;
  const deltaLabel = deltaChars === 0 ? "持平" : deltaChars > 0 ? `+${deltaChars}` : String(deltaChars);
  const stale = daysSince == null ? "本空间还没有笔记。" : `距上次更新 ${daysSince} 天。`;
  const islandLines = islands.length
    ? islands.map((n) => `- [${n.title}](/notes/${n.id})（${n.path}）`).join("\n")
    : "没有孤岛笔记。";
  const markdown = [
    `# 写作健康度（${range.from} ~ ${range.to}）`,
    "",
    "中枢只读，本报告不写回任何源。",
    "",
    "## 字数",
    `- 本周：${thisStats.chars} 字 / ${thisStats.words} 词（${thisStats.notes} 篇）`,
    `- 上周：${prevStats.chars} 字 / ${prevStats.words} 词（${prevStats.notes} 篇）`,
    `- 变化：${deltaLabel} 字`,
    "",
    "## 断更",
    stale,
    "",
    "## 孤岛",
    islandLines,
    "",
  ].join("\n");
  const summary = `写作健康：本周 ${thisStats.chars} 字，断更 ${daysSince == null ? "—" : daysSince} 天，孤岛 ${islands.length} 篇。`;
  return {
    from: range.from,
    to: range.to,
    prev_from: prevFrom,
    prev_to: prevTo,
    this_week: thisStats,
    prev_week: prevStats,
    days_since_last: daysSince,
    last_updated_at: last?.updated_at ?? null,
    islands,
    markdown,
    summary,
  };
}

export function shortWritingSummary(report: WritingHealthReport): string {
  return report.summary;
}

async function notesFor(payload: Record<string, unknown>, host: HostApi): Promise<HostNote[]> {
  const given = asNotes(payload);
  if (given.length) return given;
  return host.queryNotes();
}

export const writingHealthHandler: SkillHandler = async (input) => {
  const { hook, payload, host } = input;
  if (hook === "weekly-report") {
    const notes = await notesFor(payload, host);
    const links = await host.queryLinks();
    const report = computeWritingHealth(notes, links);
    await host.writeArtifact({
      skill_id: "writing-health",
      note_id: null,
      kind: "writing-health-report",
      payload: report as unknown as Record<string, unknown>,
    });
    return { ok: true, markdown: report.markdown, extra: report as unknown as Record<string, unknown> };
  }

  if (hook === "on-ask") {
    const query = typeof payload.query === "string" ? payload.query : "";
    if (!onAskMentionsWriting(query)) return { ok: true };
    const notes = await notesFor(payload, host);
    const links = await host.queryLinks();
    const report = computeWritingHealth(notes, links);
    return { ok: true, summary: report.summary, extra: { writing_health: report.summary } };
  }

  const unused: SkillRunResult = { ok: false, extra: { error: "unknown_hook" } };
  return unused;
};
