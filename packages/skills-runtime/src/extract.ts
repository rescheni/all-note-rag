import { splitFrontmatter } from "./parse.ts";
import type { GrowthKind, HostNote, WriteGrowthEvent } from "./types.ts";

const TAG_TO_KIND: Record<string, GrowthKind> = {
  目标: "goal",
  goal: "goal",
  goals: "goal",
  习惯: "habit",
  habit: "habit",
  habits: "habit",
  复盘: "review",
  回顾: "review",
  review: "review",
  mood: "mood",
  心情: "mood",
  情绪: "mood",
  专注: "focus",
  focus: "focus",
};

const FM_KEYS: Record<string, GrowthKind> = {
  mood: "mood",
  goals: "goal",
  goal: "goal",
  habit: "habit",
  habits: "habit",
  review: "review",
  复盘: "review",
  focus: "focus",
  专注: "focus",
};

export function isDailyLike(path: string, title: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (/\d{4}-\d{2}-\d{2}/.test(p) || /\d{4}-\d{2}-\d{2}/.test(title)) return true;
  if (/(^|\/)daily(\/|$)/i.test(p)) return true;
  if (p.includes("日记") || title.includes("日记")) return true;
  return false;
}

export function dateFromNote(note: { path: string; title: string; updated_at: string }): Date {
  const m = `${note.path} ${note.title}`.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return new Date(`${m[1]}T00:00:00.000Z`);
  const d = new Date(note.updated_at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function utcDay(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function growthEventDedupeKey(noteId: string | null | undefined, kind: GrowthKind, happenedAt: string): string {
  return `${noteId ?? ""}|${kind}|${utcDay(happenedAt)}`;
}

export function collectHashtags(markdown: string): string[] {
  const tags: string[] = [];
  const re = /#([^\s#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    tags.push(m[1].replace(/[.,，。!！?？:：;；]+$/g, ""));
  }
  return tags;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => stringifyValue(v)).filter(Boolean).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function noteFrontmatter(note: HostNote): Record<string, unknown> {
  const fromField = asRecord(note.frontmatter);
  if (fromField && Object.keys(fromField).length) return fromField;
  if (note.markdown) return splitFrontmatter(note.markdown).frontmatter;
  return {};
}

function kindsFromFrontmatter(fm: Record<string, unknown>, titles: Partial<Record<GrowthKind, string>>): Set<GrowthKind> {
  const kinds = new Set<GrowthKind>();
  for (const [k, v] of Object.entries(fm)) {
    if (v == null || v === false) continue;
    const kind = FM_KEYS[k.toLowerCase()] ?? FM_KEYS[k];
    if (!kind) continue;
    kinds.add(kind);
    const label = stringifyValue(v);
    if (label && !titles[kind]) titles[kind] = label.split(/[\n、,]/)[0]!.trim();
  }
  return kinds;
}

function kindsFromTags(tags: string[], titles: Partial<Record<GrowthKind, string>>, markdown: string): Set<GrowthKind> {
  const kinds = new Set<GrowthKind>();
  for (const tag of tags) {
    const kind = TAG_TO_KIND[tag] ?? TAG_TO_KIND[tag.toLowerCase()];
    if (!kind) continue;
    kinds.add(kind);
    if (titles[kind]) continue;
    const line = markdown.split(/\r?\n/).find((l) => l.includes(`#${tag}`));
    if (line) {
      const cleaned = line.replace(/#\S+/g, "").replace(/^[-*]\s*/, "").trim();
      if (cleaned) titles[kind] = cleaned.slice(0, 80);
    }
  }
  return kinds;
}

function kindsFromDailyBody(markdown: string, titles: Partial<Record<GrowthKind, string>>): Set<GrowthKind> {
  const kinds = new Set<GrowthKind>();
  const pairs: Array<[RegExp, GrowthKind]> = [
    [/目标|goal/i, "goal"],
    [/习惯|habit/i, "habit"],
    [/心情|情绪|\bmood\b/i, "mood"],
    [/复盘|回顾|review/i, "review"],
    [/专注|focus/i, "focus"],
  ];
  for (const [re, kind] of pairs) {
    if (re.test(markdown)) {
      kinds.add(kind);
      if (!titles[kind]) {
        const line = markdown.split(/\r?\n/).find((l) => re.test(l) && l.trim());
        if (line) titles[kind] = line.replace(/#\S+/g, "").trim().slice(0, 80);
      }
    }
  }
  return kinds;
}

function excerptOf(markdown: string | null): string {
  if (!markdown) return "";
  const { body } = splitFrontmatter(markdown);
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function extractGrowthFromNote(note: HostNote): WriteGrowthEvent[] {
  const markdown = note.markdown ?? "";
  const fm = noteFrontmatter(note);
  const tags = collectHashtags(markdown);
  const titles: Partial<Record<GrowthKind, string>> = {};
  const kinds = new Set<GrowthKind>();
  for (const k of kindsFromFrontmatter(fm, titles)) kinds.add(k);
  for (const k of kindsFromTags(tags, titles, markdown)) kinds.add(k);
  if (isDailyLike(note.path, note.title)) {
    for (const k of kindsFromDailyBody(markdown, titles)) kinds.add(k);
  }
  if (!kinds.size) return [];
  const happened = dateFromNote(note);
  const excerpt = excerptOf(markdown);
  const events: WriteGrowthEvent[] = [];
  for (const kind of kinds) {
    events.push({
      note_id: note.id,
      kind,
      happened_at: happened.toISOString(),
      payload: {
        title: titles[kind] || note.title,
        excerpt,
        tags,
        path: note.path,
        source: "heuristic",
      },
    });
  }
  return events;
}

export function mergeUniqueEvents(
  existing: Array<{ note_id: string | null; kind: GrowthKind; happened_at: string }>,
  incoming: WriteGrowthEvent[],
): WriteGrowthEvent[] {
  const seen = new Set(existing.map((e) => growthEventDedupeKey(e.note_id, e.kind, e.happened_at)));
  return incoming.filter((e) => {
    const key = growthEventDedupeKey(e.note_id ?? null, e.kind, e.happened_at);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
