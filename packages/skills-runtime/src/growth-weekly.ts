import { extractGrowthFromNote } from "./extract.ts";
import { lastSevenDayRange, onAskMentionsGrowth, renderWeeklyReport, shortGrowthSummary } from "./report.ts";
import type { HostGrowthEvent, HostNote, SkillHandler, SkillRunResult } from "./types.ts";

function asNotes(payload: Record<string, unknown>): HostNote[] {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is HostNote => Boolean(n && typeof n === "object" && "id" in n));
}

/** Accept array or comma/newline-separated string. */
export function parseStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function noteMatchesExclude(
  note: HostNote | undefined,
  noteId: string | null,
  excludeIds: Set<string>,
  excludePaths: string[],
): boolean {
  if (noteId && excludeIds.has(noteId)) return true;
  if (note && excludeIds.has(note.id)) return true;
  if (!excludePaths.length) return false;
  const path = note?.path ?? "";
  const title = note?.title ?? "";
  for (const p of excludePaths) {
    if (!p) continue;
    if (path.includes(p) || title.includes(p)) return true;
  }
  return false;
}

export function filterExcludedGrowth(
  events: HostGrowthEvent[],
  notes: HostNote[],
  excludeIds: string[],
  excludePaths: string[],
): { events: HostGrowthEvent[]; notes: HostNote[] } {
  const idSet = new Set(excludeIds);
  const noteMap = new Map(notes.map((n) => [n.id, n]));
  const keptEvents = events.filter(
    (e) => !noteMatchesExclude(e.note_id ? noteMap.get(e.note_id) : undefined, e.note_id, idSet, excludePaths),
  );
  const keptNoteIds = new Set(keptEvents.map((e) => e.note_id).filter((id): id is string => Boolean(id)));
  const keptNotes = notes.filter((n) => keptNoteIds.has(n.id) && !noteMatchesExclude(n, n.id, idSet, excludePaths));
  return { events: keptEvents, notes: keptNotes };
}

export const growthWeeklyHandler: SkillHandler = async (input) => {
  const { hook, payload, host } = input;
  if (hook === "post-sync") {
    let notes = asNotes(payload);
    if (!notes.length) {
      const ids = Array.isArray(payload.note_ids)
        ? payload.note_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length) notes = await host.queryNotes({ ids });
    }
    let written = 0;
    for (const note of notes) {
      const events = extractGrowthFromNote(note);
      for (const ev of events) {
        const r = await host.writeGrowthEvent(ev);
        if (r.created) written += 1;
      }
    }
    return { ok: true, events_written: written };
  }

  if (hook === "weekly-report") {
    const range = lastSevenDayRange();
    const from = typeof payload.from === "string" && payload.from ? payload.from : range.from;
    const to = typeof payload.to === "string" && payload.to ? payload.to : range.to;
    const excludeIds = parseStringList(payload.exclude_ids ?? payload.excludeIds);
    const excludePaths = parseStringList(payload.exclude_paths ?? payload.excludePaths);
    const events = await host.queryGrowth({ from, to });
    const ids = [...new Set(events.map((e) => e.note_id).filter((id): id is string => Boolean(id)))];
    const notes = ids.length ? await host.queryNotes({ ids }) : [];
    const filtered = filterExcludedGrowth(events, notes, excludeIds, excludePaths);
    const markdown = renderWeeklyReport({
      from,
      to,
      events: filtered.events,
      notes: filtered.notes,
      excluded: excludeIds.length || excludePaths.length
        ? { ids: excludeIds, paths: excludePaths }
        : undefined,
    });
    await host.writeReport({ range_from: from, range_to: to, markdown });
    const included_notes = filtered.notes.map((n) => ({
      id: n.id,
      title: n.title,
      path: n.path,
    }));
    return { ok: true, markdown, extra: { included_notes } };
  }

  if (hook === "on-ask") {
    const query = typeof payload.query === "string" ? payload.query : "";
    if (!onAskMentionsGrowth(query)) return { ok: true };
    const range = lastSevenDayRange();
    const events = await host.queryGrowth({ from: range.from, to: range.to });
    const summary = shortGrowthSummary(events);
    return { ok: true, summary };
  }

  const unused: SkillRunResult = { ok: false, extra: { error: "unknown_hook" } };
  return unused;
};
