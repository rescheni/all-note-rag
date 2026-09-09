import { describe, expect, it } from "vitest";
import {
  sanitizeAnswerCitations,
  composeAskAnswer,
  type AskCitation,
} from "../src/index.ts";
import type { RetrieveHit } from "../src/index.ts";

function cite(i: number): AskCitation {
  return {
    note_id: `n${i}`,
    block_id: `b${i}`,
    source_block_id: `b${i}`,
    title: `标题${i}`,
    quote: `摘录内容足够长 ${i} abcdefgh`,
    preview_url: `/notes/n${i}#b-b${i}`,
    path: `p${i}.md`,
    connection_id: "c1",
  };
}

function hit(i: number): RetrieveHit {
  return {
    space_id: "space-a",
    note_id: `n${i}`,
    title: `标题${i}`,
    text: `正文片段 ${i} 二叉树相关说明。`,
    source_block_id: `b${i}`,
    block_id: `b${i}`,
    quote: `摘录内容足够长 ${i} abcdefgh`,
    preview_url: `/notes/n${i}#b-b${i}`,
    path: `p${i}.md`,
    connection_id: "c1",
    rank: 1,
  };
}

describe("sanitizeAnswerCitations", () => {
  it("drops out-of-range 【7】【8】 when N=5 and keeps 【1】", () => {
    const citations = [1, 2, 3, 4, 5].map(cite);
    const raw = "二叉树是一种树形结构。【1】【7】【8】也可递归定义。";
    const out = sanitizeAnswerCitations(raw, citations);
    expect(out.answer_markdown).toContain("【1】");
    expect(out.answer_markdown).not.toMatch(/【[2-9]】/);
    expect(out.answer_markdown).not.toContain("【7】");
    expect(out.answer_markdown).not.toContain("【8】");
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.note_id).toBe("n1");
  });

  it("preserves valid multi cites and repacks to dense 1..M", () => {
    const citations = [1, 2, 3, 4, 5].map(cite);
    const raw = "先看定义【1】，再看遍历【3】【5】，最后【1】再强调。";
    const out = sanitizeAnswerCitations(raw, citations);
    expect(out.answer_markdown).toBe("先看定义【1】，再看遍历【2】【3】，最后【1】再强调。");
    expect(out.citations.map((c) => c.note_id)).toEqual(["n1", "n3", "n5"]);
  });

  it("strips orphan bare footnote digit lines", () => {
    const citations = [1, 2, 3].map(cite);
    const raw = "这是正文【1】。\n\n1\n2\n7\n\n结尾。";
    const out = sanitizeAnswerCitations(raw, citations);
    expect(out.answer_markdown).toContain("这是正文【1】。");
    expect(out.answer_markdown).toContain("结尾。");
    expect(out.answer_markdown.split("\n").some((l) => /^\d{1,2}$/.test(l.trim()))).toBe(false);
  });

  it("normalizes spaced / fullwidth / [n] cite variants", () => {
    const citations = [1, 2, 3].map(cite);
    const raw = "甲【 2 】乙［3］丙[1]丁[label](https://ex.com)";
    const out = sanitizeAnswerCitations(raw, citations);
    // first-appearance: 2,3,1 → dense 1,2,3
    expect(out.answer_markdown).toContain("【1】");
    expect(out.answer_markdown).toContain("【2】");
    expect(out.answer_markdown).toContain("【3】");
    expect(out.answer_markdown).toContain("[label](https://ex.com)");
    expect(out.citations.map((c) => c.note_id)).toEqual(["n2", "n3", "n1"]);
  });

  it("keeps full citation list when answer has no marks", () => {
    const citations = [1, 2].map(cite);
    const out = sanitizeAnswerCitations("没有引用的回答。", citations);
    expect(out.citations).toHaveLength(2);
    expect(out.answer_markdown).toBe("没有引用的回答。");
  });
});

describe("composeAskAnswer citation sanitize", () => {
  it("sanitizes invented high indices from chat before return", async () => {
    const hits = [1, 2, 3, 4, 5].map(hit);
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "二叉树常用递归。【1】【7】【8】\n9\n也可层序遍历。",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const out = await composeAskAnswer("什么是二叉树", hits, {
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetch: fakeFetch,
    });
    expect(out.mode).toBe("ai");
    expect(out.answer_markdown).toContain("【1】");
    expect(out.answer_markdown).not.toMatch(/【[2-9]\d*】/);
    expect(out.answer_markdown).not.toContain("【7】");
    const maxCite = Math.max(
      0,
      ...[...out.answer_markdown.matchAll(/【(\d+)】/g)].map((m) => Number(m[1])),
    );
    expect(maxCite).toBeLessThanOrEqual(out.citations.length);
    expect(out.citations.length).toBe(1);
  });
});
