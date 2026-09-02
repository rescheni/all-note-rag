import { describe, expect, it } from "vitest";
import { addYmd, buildActivitySeries, shanghaiYmd } from "../src/activity.ts";
import { parseSiyuanUpdated, resolveNoteSourceUpdatedAt } from "../src/source-updated.ts";

describe("activity aggregation", () => {
  it("fills every Shanghai day and sums notes + upserts", () => {
    const now = new Date("2026-03-12T16:30:00Z"); // 2026-03-13 00:30 Asia/Shanghai
    const today = shanghaiYmd(now);
    expect(today).toBe("2026-03-13");
    const series = buildActivitySeries({
      days: 7,
      now,
      notes: [
        { date: "2026-03-12", notes: 2 },
        { date: "2026-03-13", notes: 1 },
      ],
      upserts: [{ date: "2026-03-12", upserts: 4 }],
    });
    expect(series).toHaveLength(7);
    expect(series[0]?.date).toBe(addYmd("2026-03-13", -6));
    expect(series.at(-1)).toMatchObject({ date: "2026-03-13", notes: 1, upserts: 0 });
    const d12 = series.find((d) => d.date === "2026-03-12");
    expect(d12).toMatchObject({ notes: 2, upserts: 4 });
  });

  it("counts a late-UTC update on the next Shanghai date", () => {
    const now = new Date("2026-01-01T16:00:00Z");
    expect(shanghaiYmd(now)).toBe("2026-01-02");
  });
});

describe("parseSiyuanUpdated", () => {
  it("parses YYYYMMDDHHmmss as Asia/Shanghai wall time", () => {
    const d = parseSiyuanUpdated("20250414073505");
    expect(d).toBeTruthy();
    expect(d!.toISOString()).toBe("2025-04-13T23:35:05.000Z");
  });

  it("returns null for invalid compact stamps", () => {
    expect(parseSiyuanUpdated("20251314073505")).toBeNull();
    expect(parseSiyuanUpdated("not-a-date")).toBeNull();
    expect(parseSiyuanUpdated("")).toBeNull();
  });

  it("accepts unix millis", () => {
    const ms = Date.parse("2025-04-13T23:35:05.000Z");
    const d = parseSiyuanUpdated(ms);
    expect(d?.toISOString()).toBe("2025-04-13T23:35:05.000Z");
  });
});

describe("resolveNoteSourceUpdatedAt", () => {
  const now = new Date("2026-09-01T05:00:00Z");

  it("prefers SiYuan Properties.updated over ingest now", () => {
    const raw = JSON.stringify({
      ID: "20250414073505-abcd123",
      Properties: { title: "x", updated: "20250414073505" },
    });
    const d = resolveNoteSourceUpdatedAt({
      source: "siyuan",
      payload: { raw, etag: "file-hash-not-a-date" },
      now,
    });
    expect(d.toISOString()).toBe("2025-04-13T23:35:05.000Z");
  });

  it("uses Obsidian frontmatter updated/date, else now", () => {
    const fromFm = resolveNoteSourceUpdatedAt({
      source: "obsidian",
      payload: { raw: "hi" },
      frontmatter: { updated: "2025-04-14" },
      now,
    });
    expect(fromFm.toISOString().startsWith("2025-04-14")).toBe(true);
    const fallback = resolveNoteSourceUpdatedAt({
      source: "obsidian",
      payload: { raw: "hi" },
      frontmatter: {},
      now,
    });
    expect(fallback.toISOString()).toBe(now.toISOString());
  });
});
