import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryHost,
  extractGrowthFromNote,
  growthAccessError,
  growthWeeklyHandler,
  listHooks,
  loadOfficialSkill,
  parseSkillMd,
  renderWeeklyReport,
  officialSkillDir,
} from "../src/index.ts";

describe("parse SKILL.md", () => {
  it("reads official growth-weekly hooks", () => {
    const dir = officialSkillDir("growth-weekly");
    const md = readFileSync(join(dir, "SKILL.md"), "utf8");
    const { manifest } = parseSkillMd(md);
    expect(manifest.name).toBe("growth-weekly");
    expect(listHooks(manifest)).toEqual(["post-sync", "on-ask", "weekly-report"]);
    const loaded = loadOfficialSkill("growth-weekly");
    expect(loaded.manifest.hooks).toContain("weekly-report");
  });
});

describe("extract growth", () => {
  it("extracts from a daily note fixture and does not duplicate", async () => {
    const dir = officialSkillDir("growth-weekly");
    const markdown = readFileSync(join(dir, "fixtures/daily-2026-08-25.md"), "utf8");
    const note = {
      id: "note-daily-1",
      path: "Daily/2026-08-25.md",
      title: "2026-08-25",
      markdown,
      frontmatter: null,
      hash: "abc",
      updated_at: "2026-08-25T12:00:00.000Z",
    };
    const events = extractGrowthFromNote(note);
    expect(events.some((e) => e.kind === "goal")).toBe(true);
    expect(events.some((e) => e.kind === "habit")).toBe(true);
    expect(events.map((e) => e.kind).sort()).toEqual(
      [...new Set(events.map((e) => e.kind))].sort(),
    );

    const host = createMemoryHost({ spaceId: "space-p", userId: "user-1" });
    const first = await growthWeeklyHandler({
      space_id: "space-p",
      hook: "post-sync",
      payload: { notes: [note] },
      host,
    });
    const second = await growthWeeklyHandler({
      space_id: "space-p",
      hook: "post-sync",
      payload: { notes: [note] },
      host,
    });
    expect(first.events_written).toBeGreaterThan(0);
    expect(second.events_written).toBe(0);
    expect(host.events.filter((e) => e.kind === "goal")).toHaveLength(1);
  });
});

describe("growth API personal-only check", () => {
  it("rejects team space", () => {
    const err = growthAccessError("team");
    expect(err?.code).toBe("growth_personal_only");
    expect(err?.message).toContain("个人空间");
    expect(growthAccessError("personal")).toBeNull();
  });
});

describe("weekly report", () => {
  it("markdown contains a goal title", () => {
    const md = renderWeeklyReport({
      from: "2026-08-24",
      to: "2026-08-31",
      events: [
        {
          note_id: "note-daily-1",
          kind: "goal",
          happened_at: "2026-08-25T00:00:00.000Z",
          payload: { title: "完成本周周报" },
        },
      ],
      notes: [
        {
          id: "note-daily-1",
          path: "Daily/2026-08-25.md",
          title: "2026-08-25",
          markdown: "",
          frontmatter: {},
          updated_at: "2026-08-25T00:00:00.000Z",
        },
      ],
    });
    expect(md).toContain("完成本周周报");
    expect(md).toContain("/notes/note-daily-1");
  });
});
