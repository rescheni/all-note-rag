import { collectHashtags } from "./extract.ts";
import { splitFrontmatter } from "./parse.ts";
import type { HostNote, SkillHandler, SkillRunResult } from "./types.ts";

export type MeetingTodo = { text: string; done: boolean };

export type MeetingExtract = {
  title: string;
  path: string;
  attendees: string[];
  decisions: string[];
  todos: MeetingTodo[];
};

function asNotes(payload: Record<string, unknown>): HostNote[] {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is HostNote => Boolean(n && typeof n === "object" && "id" in n));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function noteFrontmatter(note: HostNote): Record<string, unknown> {
  const fromField = asRecord(note.frontmatter);
  if (fromField && Object.keys(fromField).length) return fromField;
  if (note.markdown) return splitFrontmatter(note.markdown).frontmatter;
  return {};
}

function stringifyList(value: unknown): string[] {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  return s.split(/[,，、;；\n]+/).map((p) => p.trim()).filter(Boolean);
}

function unique(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const t = item.replace(/^@/, "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

const MEETING_RE = /会议|meeting|纪要/i;

export function looksLikeMeeting(note: HostNote): boolean {
  const fm = noteFrontmatter(note);
  if (String(fm.type ?? "").toLowerCase() === "meeting") return true;
  const tags = collectHashtags(note.markdown ?? "");
  const fmTags = stringifyList(fm.tags ?? fm.tag);
  const hay = `${note.title} ${note.path} ${tags.join(" ")} ${fmTags.join(" ")}`;
  return MEETING_RE.test(hay);
}

function bodyOf(note: HostNote): string {
  const raw = note.markdown ?? "";
  return splitFrontmatter(raw).body;
}

function sectionItems(markdown: string, headingRe: RegExp): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = headingRe.test(heading[1].trim());
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (m) items.push(m[1].trim());
  }
  return items.filter(Boolean);
}

function checkboxTodos(markdown: string): MeetingTodo[] {
  const todos: MeetingTodo[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    todos.push({ text: m[2].trim(), done: m[1] !== " " });
  }
  return todos.filter((t) => t.text);
}

function mentions(markdown: string): string[] {
  const out: string[] = [];
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    out.push(m[1].replace(/[.,，。!！?？:：;；]+$/g, ""));
  }
  return out;
}

export function extractMeetingFromNote(note: HostNote): MeetingExtract | null {
  if (!looksLikeMeeting(note)) return null;
  const fm = noteFrontmatter(note);
  const body = bodyOf(note);
  const attendees = unique([
    ...stringifyList(fm.attendees ?? fm.参会 ?? fm.participants),
    ...sectionItems(body, /参会|attendees?/i),
    ...mentions(body),
  ]);
  const decisions = unique([
    ...stringifyList(fm.decisions ?? fm.决议 ?? fm.决定),
    ...sectionItems(body, /决议|决定|decisions?/i),
  ]);
  const fromBoxes = checkboxTodos(body);
  const fromSection = sectionItems(body, /待办|todos?|action\s*items?/i).map((text) => ({
    text,
    done: false,
  }));
  const todos: MeetingTodo[] = [];
  const seen = new Set<string>();
  for (const t of [...fromBoxes, ...fromSection]) {
    const key = t.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    todos.push(t);
  }
  if (!attendees.length && !decisions.length && !todos.length) return null;
  return {
    title: note.title,
    path: note.path,
    attendees,
    decisions,
    todos,
  };
}

export const meetingExtractHandler: SkillHandler = async (input) => {
  const { hook, payload, host } = input;
  if (hook !== "post-sync") {
    const unused: SkillRunResult = { ok: false, extra: { error: "unknown_hook" } };
    return unused;
  }
  let notes = asNotes(payload);
  if (!notes.length) {
    const ids = Array.isArray(payload.note_ids)
      ? payload.note_ids.filter((id): id is string => typeof id === "string")
      : [];
    if (ids.length) notes = await host.queryNotes({ ids });
  }
  let written = 0;
  let skipped = 0;
  for (const note of notes) {
    const parsed = extractMeetingFromNote(note);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    await host.writeArtifact({
      skill_id: "meeting-extract",
      note_id: note.id,
      kind: "meeting",
      payload: parsed as unknown as Record<string, unknown>,
    });
    written += 1;
  }
  return { ok: true, extra: { written, skipped } };
};
