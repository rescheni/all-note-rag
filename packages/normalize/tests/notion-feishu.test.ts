import { describe, expect, it } from "vitest";
import {
  flattenNotionProperties,
  normalizeFeishuNote,
  normalizeNotionNote,
  notionBlocksToMarkdown,
  feishuBlocksToMarkdown,
  feishuMediaRefs,
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


  it("stores page.icon emoji on frontmatter", () => {
    const note = normalizeNotionNote(
      {
        source_id: "abc",
        path: "Icon page",
        title: "Icon page",
        raw: JSON.stringify({
          page: {
            object: "page",
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            icon: { type: "emoji", emoji: "🚀" },
            properties: {
              title: { type: "title", title: [{ plain_text: "Icon page", type: "text", text: { content: "Icon page" } }] },
            },
          },
          blocks: [],
        }),
      },
      "conn",
    );
    expect(note.frontmatter.icon).toBe("🚀");
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

describe("notion media blocks", () => {
  it("renders players for notion-hosted video/audio and keeps embed/bookmark urls", () => {
    const converted = notionBlocksToMarkdown([
      {
        id: "33333333-3333-3333-3333-333333333333",
        type: "video",
        video: { type: "file", file: { url: "https://prod-files.notion.so/x/clip.mp4?sig=1" } },
      },
      {
        id: "44444444-4444-4444-4444-444444444444",
        type: "audio",
        audio: { type: "external", external: { url: "https://cdn.example.com/voice.mp3" } },
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        type: "video",
        video: { type: "external", external: { url: "https://www.youtube.com/watch?v=abc123" } },
      },
      {
        id: "66666666-6666-6666-6666-666666666666",
        type: "embed",
        embed: { url: "https://example.com/dashboard" },
      },
      {
        id: "77777777-7777-7777-7777-777777777777",
        type: "bookmark",
        bookmark: { url: "https://example.com/post", caption: [] },
      },
      {
        id: "88888888-8888-8888-8888-888888888888",
        type: "pdf",
        pdf: { type: "file", file: { url: "https://prod-files.notion.so/x/spec.pdf?sig=1" }, name: "spec.pdf" },
      },
    ]);

    // Notion-hosted video -> player, url preserved verbatim so the adapter can swap it.
    expect(converted.markdown).toContain('<video controls src="https://prod-files.notion.so/x/clip.mp4?sig=1"></video>');
    // Direct external audio file -> player.
    expect(converted.markdown).toContain('<audio controls src="https://cdn.example.com/voice.mp3"></audio>');
    // YouTube page link is not a media file -> stays a link, never a broken player.
    expect(converted.markdown).toContain("https://www.youtube.com/watch?v=abc123");
    expect(converted.markdown).not.toContain('<video controls src="https://www.youtube.com/watch');
    // embed / bookmark / pdf references survive.
    expect(converted.markdown).toContain("(https://example.com/dashboard)");
    expect(converted.markdown).toContain("(https://example.com/post)");
    expect(converted.markdown).toContain("[spec.pdf](https://prod-files.notion.so/x/spec.pdf?sig=1)");
    expect(converted.blocks.every((b) => b.type === "embed")).toBe(true);
  });

  it("drops nothing silently when a media block has no url", () => {
    const converted = notionBlocksToMarkdown([
      { id: "99999999-9999-9999-9999-999999999999", type: "video", video: {} },
    ]);
    expect(converted.markdown).toBe("");
  });
});

describe("feishu media blocks", () => {
  const blocks = [
    { block_id: "b0", block_type: 1, page: { elements: [{ text_run: { content: "Media Doc" } }] } },
    { block_id: "b1", block_type: 27, image: { token: "imgtok" } },
    { block_id: "b2", block_type: 23, file: { token: "vidtok", name: "VID_20231224_163819.mp4" } },
    { block_id: "b3", block_type: 23, file: { token: "audtok", name: "meeting-recording.m4a" } },
    { block_id: "b4", block_type: 23, file: { token: "doctok", name: "report.docx" } },
    { block_id: "b5", block_type: 33, view: { view_type: 2 } },
    {
      block_id: "b6",
      block_type: 26,
      iframe: { component: { type: 1, url: "https%3A%2F%2Fplayer.bilibili.com%2Fplayer.html%3Fbvid%3DBV1x" } },
    },
  ];

  it("classifies file blocks (23) as audio/video by name and keeps iframe (26) urls", () => {
    const refs = feishuMediaRefs(blocks);
    expect(refs).toEqual([
      { token: "imgtok", name: "imgtok.png", kind: "image" },
      { token: "vidtok", name: "VID_20231224_163819.mp4", kind: "video" },
      { token: "audtok", name: "meeting-recording.m4a", kind: "audio" },
      { token: "doctok", name: "report.docx", kind: "file" },
    ]);

    const converted = feishuBlocksToMarkdown(blocks);
    expect(converted.markdown).toContain('<video controls src="VID_20231224_163819.mp4"></video>');
    expect(converted.markdown).toContain('<audio controls src="meeting-recording.m4a"></audio>');
    expect(converted.markdown).toContain("[report.docx](report.docx)");
    expect(converted.markdown).toContain("![](imgtok.png)");
    // iframe url is url-encoded upstream; decoded into a visible link.
    expect(converted.markdown).toContain("https://player.bilibili.com/player.html?bvid=BV1x");
  });

  it("dedupes tokens and survives blocks with no token", () => {
    const refs = feishuMediaRefs([
      { block_id: "a", block_type: 23, file: { token: "t1", name: "a.mp3" } },
      { block_id: "b", block_type: 23, file: { token: "t1", name: "a.mp3" } },
      { block_id: "c", block_type: 23, file: { name: "no-token.mp4" } },
      { block_id: "d", block_type: 27, image: {} },
    ]);
    expect(refs).toEqual([{ token: "t1", name: "a.mp3", kind: "audio" }]);
  });

  it("keeps media players through normalizeFeishuNote blocks", () => {
    const converted = feishuBlocksToMarkdown(blocks);
    const note = normalizeFeishuNote(
      { source_id: "doxcnMEDIA", path: "Media Doc", title: "Media Doc", raw: converted.markdown },
      "c1",
    );
    expect(note.blocks.some((b) => b.markdown.includes("<video controls"))).toBe(true);
    expect(note.blocks.some((b) => b.markdown.includes("<audio controls"))).toBe(true);
  });
});
