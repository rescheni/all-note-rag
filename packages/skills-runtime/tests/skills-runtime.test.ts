import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeWritingHealth,
  createMemoryHost,
  extractGrowthFromNote,
  extractMeetingFromNote,
  growthAccessError,
  growthWeeklyHandler,
  isOfficialSkillId,
  listHooks,
  listOfficialCatalog,
  loadOfficialSkill,
  meetingExtractHandler,
  parseSkillMd,
  renderWeeklyReport,
  officialSkillDir,
  writingHealthHandler,
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


describe("official catalog", () => {
  it("lists growth-weekly, meeting-extract and writing-health", () => {
    const ids = listOfficialCatalog().map((s) => s.id);
    expect(ids).toContain("growth-weekly");
    expect(ids).toContain("meeting-extract");
    expect(ids).toContain("writing-health");
    expect(isOfficialSkillId("meeting-extract")).toBe(true);
    expect(isOfficialSkillId("writing-health")).toBe(true);
    expect(isOfficialSkillId("not-a-skill")).toBe(false);
  });
});

describe("parse SKILL.md extra official skills", () => {
  it("parses meeting-extract and writing-health", () => {
    const meetingMd = readFileSync(join(officialSkillDir("meeting-extract"), "SKILL.md"), "utf8");
    const meeting = parseSkillMd(meetingMd);
    expect(meeting.manifest.name).toBe("meeting-extract");
    expect(listHooks(meeting.manifest)).toEqual(["post-sync"]);
    expect(meeting.manifest.permissions.notes).toBe("read");
    expect(meeting.manifest.permissions.network).toBe(false);

    const healthMd = readFileSync(join(officialSkillDir("writing-health"), "SKILL.md"), "utf8");
    const health = parseSkillMd(healthMd);
    expect(health.manifest.name).toBe("writing-health");
    expect(listHooks(health.manifest)).toEqual(["weekly-report", "on-ask"]);
    expect(health.manifest.permissions.notes).toBe("read");
    expect(health.manifest.permissions.network).toBe(false);
  });
});

describe("meeting extract", () => {
  it("extracts 决议 and checkbox 待办 from a fixture note", async () => {
    const dir = officialSkillDir("meeting-extract");
    const markdown = readFileSync(join(dir, "fixtures/standup-2026-08-28.md"), "utf8");
    const note = {
      id: "note-mtg-1",
      path: "Meetings/周会纪要.md",
      title: "产品周会纪要",
      markdown,
      frontmatter: { type: "meeting" },
      hash: "m1",
      updated_at: "2026-08-28T12:00:00.000Z",
    };
    const parsed = extractMeetingFromNote(note);
    expect(parsed).not.toBeNull();
    expect(parsed!.decisions.some((d) => d.includes("下周发布"))).toBe(true);
    expect(parsed!.todos.some((t) => t.text.includes("写验收"))).toBe(true);
    expect(parsed!.attendees.length).toBeGreaterThan(0);

    const host = createMemoryHost({ spaceId: "space-t", userId: "user-1", spaceKind: "team" });
    const result = await meetingExtractHandler({
      space_id: "space-t",
      hook: "post-sync",
      payload: { notes: [note] },
      host,
    });
    expect(result.ok).toBe(true);
    expect(host.artifacts).toHaveLength(1);
    expect(host.artifacts[0].kind).toBe("meeting");
  });

  it("skips non-meeting notes without failing", async () => {
    const host = createMemoryHost({ spaceId: "space-t", userId: "user-1", spaceKind: "team" });
    const note = {
      id: "note-daily",
      path: "Daily/2026-08-28.md",
      title: "日记",
      markdown: "今天天气不错",
      frontmatter: {},
      hash: "d1",
      updated_at: "2026-08-28T12:00:00.000Z",
    };
    const result = await meetingExtractHandler({
      space_id: "space-t",
      hook: "post-sync",
      payload: { notes: [note] },
      host,
    });
    expect(result.ok).toBe(true);
    expect(host.artifacts).toHaveLength(0);
  });
});

describe("writing-health", () => {
  it("flags an island note", async () => {
    const island = {
      id: "n-island",
      path: "孤岛.md",
      title: "孤岛笔记",
      markdown: "无人引用也无出链",
      frontmatter: {},
      updated_at: "2026-08-31T00:00:00.000Z",
    };
    const linked = {
      id: "n-linked",
      path: "hub.md",
      title: "索引",
      markdown: "指向其他笔记",
      frontmatter: {},
      updated_at: "2026-08-31T00:00:00.000Z",
    };
    const other = {
      id: "n-other",
      path: "other.md",
      title: "其他",
      markdown: "被引用",
      frontmatter: {},
      updated_at: "2026-08-30T00:00:00.000Z",
    };
    const notes = [island, linked, other];
    const links = [{ from_note_id: "n-linked", to_note_id: "n-other" }];
    const report = computeWritingHealth(notes, links, new Date("2026-08-31T12:00:00.000Z"));
    expect(report.islands.map((n) => n.id)).toContain("n-island");
    expect(report.islands.map((n) => n.id)).not.toContain("n-linked");
    expect(report.islands.map((n) => n.id)).not.toContain("n-other");

    const host = createMemoryHost({
      spaceId: "space-p",
      userId: "u1",
      notes,
      links,
    });
    const result = await writingHealthHandler({
      space_id: "space-p",
      hook: "weekly-report",
      payload: {},
      host,
    });
    expect(result.ok).toBe(true);
    expect(host.artifacts).toHaveLength(1);
    expect(host.artifacts[0].kind).toBe("writing-health-report");
    const islands = host.artifacts[0].payload.islands as Array<{ id: string }>;
    expect(islands.some((n) => n.id === "n-island")).toBe(true);
  });
});
