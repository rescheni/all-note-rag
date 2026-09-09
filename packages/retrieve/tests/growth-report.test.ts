import { describe, expect, it } from "vitest";
import { clipNoteExcerpt, composeGrowthAiReport } from "../src/growth-report.ts";
import { ChatUpstreamError } from "../src/answer.ts";

describe("clipNoteExcerpt", () => {
  it("returns placeholder for empty", () => {
    expect(clipNoteExcerpt("")).toBe("（无正文）");
    expect(clipNoteExcerpt(null)).toBe("（无正文）");
  });

  it("caps long markdown", () => {
    const long = "甲".repeat(1200);
    const out = clipNoteExcerpt(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("composeGrowthAiReport", () => {
  it("calls chat completions and returns content", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "# 成长\n\n本周节奏平稳。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const md = await composeGrowthAiReport(
      "# 底稿\n- 习惯 1",
      [{ id: "n1", title: "日记", path: "daily/a.md", markdown: "今天跑步了。" }],
      { baseUrl: "https://example.test/v1", apiKey: "k", model: "gpt-test", fetch: fetchFn as typeof fetch },
    );
    expect(md).toContain("成长");
  });

  it("throws ChatUpstreamError on HTTP failure", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: { message: "insufficient_quota", code: "insufficient_quota" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    await expect(
      composeGrowthAiReport("底稿", [], {
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        fetch: fetchFn as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ChatUpstreamError);
  });
});
