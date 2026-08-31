import { describe, expect, it } from "vitest";
import {
  flattenNotionProperties,
  normalizeFeishuNote,
  normalizeNotionNote,
  notionBlocksToMarkdown,
  feishuBlocksToMarkdown,
} from "../src/index.ts";

describe("normalizeNotionNote", () => {
  it("flattens properties into frontmatter and extracts heading/para", () => {
    const properties = {
      Name: { type: "title", title: [{ plain_text: "Alpha", text: { content: "Alpha" } }] },
      Status: { type: "select", select: { name: "Done" } },
      Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
    };
    const flat = flattenNotionProperties(properties);
    expect(flat.Name).toBe("Alpha");
    expect(flat.Status).toBe("Done");
    expect(flat.Tags).toEqual(["a", "b"]);

    const converted = notionBlocksToMarkdown([
      {
        id: "11111111-1111-1111-1111-111111111111",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Hello Notion", text: { content: "Hello Notion" } }] },
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "A paragraph of content", text: { content: "A paragraph of content" } }] },
      },
    ]);
    expect(converted.markdown).toContain("# Hello Notion");
    expect(converted.blocks[0].source_block_id).toBe("11111111111111111111111111111111");

    const note = normalizeNotionNote(
      {
        source_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: "Alpha",
        title: "Alpha",
        raw: converted.markdown,
      },
      "c1",
    );
    expect(note.blocks.some((b) => b.type === "heading")).toBe(true);
    expect(note.blocks.some((b) => b.type === "para")).toBe(true);
    expect(note.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(note.markdown).toContain("# Hello Notion");
  });
});

describe("normalizeFeishuNote", () => {
  it("converts heading and paragraph blocks", () => {
    const converted = feishuBlocksToMarkdown([
      { block_id: "b0", block_type: 1, page: { elements: [{ text_run: { content: "Doc One" } }] } },
      { block_id: "b1", block_type: 3, heading1: { elements: [{ text_run: { content: "Hello Feishu" } }] } },
      { block_id: "b2", block_type: 2, text: { elements: [{ text_run: { content: "A paragraph from wiki" } }] } },
    ]);
    expect(converted.title).toBe("Doc One");
    expect(converted.markdown).toContain("# Hello Feishu");
    expect(converted.blocks[0].source_block_id).toBe("b1");

    const note = normalizeFeishuNote(
      { source_id: "doxcnAAA", path: "Doc One", title: "Doc One", raw: converted.markdown },
      "c1",
    );
    expect(note.blocks.some((b) => b.type === "heading" && b.text.includes("Hello Feishu"))).toBe(true);
    expect(note.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
