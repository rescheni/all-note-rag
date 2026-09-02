import { describe, expect, it } from "vitest";
import { normalizeSiyuanNote, syToMarkdown } from "../src/index.ts";

const parentSy = {
  ID: "20200813053012-parent0",
  Spec: "2",
  Type: "NodeDocument",
  Properties: {
    id: "20200813053012-parent0",
    title: "欢迎",
    type: "doc",
    updated: "20200813053012",
  },
  Children: [
    {
      Type: "NodeHeading",
      ID: "20200813053013-head001",
      HeadingLevel: 1,
      Properties: { id: "20200813053013-head001", updated: "20200813053013" },
      Children: [{ Type: "NodeText", Data: "欢迎思源" }],
    },
    {
      Type: "NodeParagraph",
      ID: "20200813053014-para001",
      Properties: { id: "20200813053014-para001", updated: "20200813053014" },
      Children: [
        { Type: "NodeText", Data: "这是明文工作区夹具。引用子文档 " },
        {
          Type: "NodeBlockRef",
          Children: [{ Type: "NodeBlockRefID", Data: "20200813054500-nchild0" }],
        },
        { Type: "NodeText", Data: "。" },
      ],
    },
  ],
};

describe("syToMarkdown", () => {
  it("heading + paragraph + block-ref", () => {
    const { markdown, blocks, links } = syToMarkdown(parentSy);
    expect(markdown).toContain("# 欢迎思源");
    expect(markdown).toContain("((20200813054500-nchild0))");
    expect(blocks.some((b) => b.type === "heading" && b.text.includes("欢迎思源"))).toBe(true);
    expect(blocks.some((b) => b.type === "para")).toBe(true);
    expect(blocks.find((b) => b.type === "heading")?.source_block_id).toBe("20200813053013-head001");
    expect(links.some((l) => l.kind === "ref" && l.to_source_id === "20200813054500-nchild0")).toBe(
      true,
    );
  });

  it("accepts lowercase type/id/children keys", () => {
    const { markdown, blocks } = syToMarkdown({
      type: "Document",
      id: "20200813053012-parent0",
      properties: { title: "x" },
      children: [
        {
          type: "Heading",
          id: "h1",
          headingLevel: 2,
          children: [{ type: "Text", data: "Hi" }],
        },
      ],
    });
    expect(markdown).toContain("## Hi");
    expect(blocks[0].source_block_id).toBe("h1");
  });

  it("converts NodeImage to markdown image instead of jammed text", () => {
    const { markdown } = syToMarkdown({
      Type: "NodeDocument",
      Children: [
        {
          Type: "NodeParagraph",
          ID: "p-img",
          Children: [
            {
              Type: "NodeImage",
              Children: [
                { Type: "NodeBang", Data: "!" },
                { Type: "NodeOpenBracket", Data: "[" },
                { Type: "NodeLinkText", Data: "image" },
                { Type: "NodeCloseBracket", Data: "]" },
                { Type: "NodeOpenParen", Data: "(" },
                { Type: "NodeLinkDest", Data: "assets/foo.png" },
                { Type: "NodeCloseParen", Data: ")" },
              ],
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("![image](assets/foo.png)");
    expect(markdown).not.toContain("imageassets/foo.png");
  });

  it("converts HTMLBlock img tags to markdown images", () => {
    const { markdown } = syToMarkdown({
      Type: "NodeDocument",
      Children: [
        {
          Type: "NodeHTMLBlock",
          Data: '<img src="assets/bar.png" alt="photo">',
        },
      ],
    });
    expect(markdown).toContain("![photo](assets/bar.png)");
  });
});

describe("normalizeSiyuanNote", () => {
  it("uses native block ids and hashes markdown", () => {
    const note = normalizeSiyuanNote(
      {
        source_id: "20200813053012-parent0",
        path: "data/box/20200813053012-parent0.sy",
        title: "欢迎",
        raw: JSON.stringify(parentSy),
      },
      "conn1",
    );
    expect(note.title).toBe("欢迎");
    expect(note.blocks[0].source_block_id).toBe("20200813053013-head001");
    expect(note.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(note.links[0].kind).toBe("ref");
  });
});
