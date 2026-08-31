import { extractGrowthFromNote } from "./extract.ts";
import { lastSevenDayRange, onAskMentionsGrowth, renderWeeklyReport, shortGrowthSummary } from "./report.ts";
import type { HostNote, SkillHandler, SkillRunResult } from "./types.ts";

function asNotes(payload: Record<string, unknown>): HostNote[] {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is HostNote => Boolean(n && typeof n === "object" && "id" in n));
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
    const events = await host.queryGrowth({ from, to });
    const ids = [...new Set(events.map((e) => e.note_id).filter((id): id is string => Boolean(id)))];
    const notes = ids.length ? await host.queryNotes({ ids }) : [];
    const markdown = renderWeeklyReport({ from, to, events, notes });
    await host.writeReport({ range_from: from, range_to: to, markdown });
    return { ok: true, markdown };
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
