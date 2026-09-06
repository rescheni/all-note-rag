import { describe, expect, it } from "vitest";
import { promoteMediaAnchors, renderPreviewHtml, rewritePreviewAssetUrls } from "../src/index.ts";

const block = (
  overrides: Partial<{
    source_block_id: string;
    type: "heading" | "para" | "code";
    text: string;
    markdown: string;
    order_key: string;
    depth: number;
  }>,
) => ({
  source_block_id: "p1",
  type: "para" as const,
  text: "",
  markdown: "",
  order_key: "0000",
  depth: 1,
  ...overrides,
});

describe("preview anchors", () => {
  it("emits b- anchors", () => {
    const html = renderPreviewHtml({
      title: "Welcome",
      path: "Welcome.md",
      hash: "abc",
      blocks: [
        {
          source_block_id: "welcome/heading0-aaaa1111",
          type: "heading",
          text: "Welcome",
          markdown: "# Welcome",
          order_key: "0000",
          depth: 1,
        },
        {
          source_block_id: "welcome/para0-bbbb2222",
          type: "para",
          text: "欢迎来到笔记中枢夹具库。",
          markdown: "欢迎来到笔记中枢夹具库。",
          order_key: "0001",
          depth: 1,
        },
      ],
    });
    expect(html).toContain('id="b-welcome/heading0-aaaa1111"');
    expect(html).toContain('id="b-welcome/para0-bbbb2222"');
    expect(html).toContain("欢迎来到笔记中枢夹具库");
  });
});

describe("healing preview chrome", () => {
  it("uses paper CSS instead of IBM Plex tech-doc", () => {
    const html = renderPreviewHtml({
      title: "纸",
      path: "a.md",
      hash: "h",
      blocks: [block({ markdown: "正文", text: "正文" })],
    });
    expect(html).toContain('data-preview-style="healing-paper-v8-ink"');
    expect(html).toContain("Noto Serif SC");
    expect(html).toContain("Noto Sans SC");
    expect(html).toContain("#fffaf2");
    expect(html).toContain("#3c332c");
    expect(html).toContain("#5e8a68");
    expect(html).toContain('html[data-theme="ink"]');
    expect(html).toContain("#1c1916");
    expect(html).toContain("#e8e0d4");
    expect(html).not.toContain("IBM Plex");
    expect(html).not.toContain("#1a1a1a");
  });
});

describe("HTML fragments", () => {
  it("renders a safe HTML subset instead of escaped tags", () => {
    const html = renderPreviewHtml({
      title: "html note",
      path: "x.md",
      hash: "h",
      blocks: [
        block({
          source_block_id: "html1",
          text: "学习笔记",
          markdown: '<div class="protyle"><p>学习笔记</p><script>alert(1)</script><img src="javascript:alert(1)"></div>',
        }),
      ],
    });
    expect(html).toContain("<p>学习笔记</p>");
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("<div");
  });

  it("keeps fenced HTML as code", () => {
    const html = renderPreviewHtml({
      title: "code",
      path: "c.md",
      hash: "h",
      blocks: [
        block({
          source_block_id: "c1",
          type: "code",
          text: "<div>raw</div>",
          markdown: "```html\n<div>raw</div>\n```",
        }),
      ],
    });
    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toMatch(/<div>raw<\/div>/);
  });
});

describe("rewritePreviewAssetUrls", () => {
  it("turns jammed SiYuan imageassets/foo.png into an img", () => {
    const html = rewritePreviewAssetUrls(
      "<p>imageassets/foo.png</p>",
      "/v1/notes/n1/assets?path=",
    );
    expect(html).toMatch(/<img[^>]+src="\/v1\/notes\/n1\/assets\?path=assets\/foo\.png"/);
    expect(html).not.toContain("imageassets/foo.png");
  });

  it("rewrites relative img src onto assetBase", () => {
    const html = rewritePreviewAssetUrls(
      '<p><img src="assets/welcome.png" alt="w"></p>',
      "/v1/notes/n1/assets?path=",
    );
    expect(html).toContain('src="/v1/notes/n1/assets?path=assets/welcome.png"');
  });
});

describe("media players in preview", () => {
  it("keeps allowlisted audio/video and strips event handlers + autoplay", () => {
    const html = renderPreviewHtml({
      title: "media",
      path: "m.md",
      hash: "h",
      blocks: [
        block({
          source_block_id: "v1",
          text: "clip",
          markdown: '<video controls src="clip.mp4" poster="thumb.png" onerror="alert(1)" autoplay></video>',
        }),
        block({
          source_block_id: "a1",
          text: "voice",
          markdown: '<audio controls src="voice.mp3" onplay="alert(1)"></audio>',
        }),
      ],
    });
    expect(html).toContain("<video");
    expect(html).toContain("<audio");
    expect(html).toContain('src="clip.mp4"');
    expect(html).toContain('poster="thumb.png"');
    expect(html).toContain("controls");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onplay");
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("alert(1)");
  });

  it("rejects javascript: urls on media src", () => {
    const html = renderPreviewHtml({
      title: "bad",
      path: "b.md",
      hash: "h",
      blocks: [
        block({ source_block_id: "v2", text: "x", markdown: '<video controls src="javascript:alert(1)"></video>' }),
      ],
    });
    expect(html).not.toContain("javascript:alert");
  });

  it("rewrites relative video/audio/source src onto assetBase", () => {
    const html = rewritePreviewAssetUrls(
      '<p><video controls src="clip.mp4" poster="thumb.png"></video><audio controls src="voice.mp3"></audio>' +
        '<video controls><source src="alt.webm" type="video/webm"></video></p>',
      "/v1/notes/n1/assets?path=",
    );
    expect(html).toContain('src="/v1/notes/n1/assets?path=clip.mp4"');
    expect(html).toContain('poster="/v1/notes/n1/assets?path=thumb.png"');
    expect(html).toContain('src="/v1/notes/n1/assets?path=voice.mp3"');
    expect(html).toContain('src="/v1/notes/n1/assets?path=alt.webm"');
  });

  it("leaves absolute media urls alone", () => {
    const html = rewritePreviewAssetUrls(
      '<p><video controls src="https://cdn.example.com/clip.mp4"></video></p>',
      "/v1/notes/n1/assets?path=",
    );
    expect(html).toContain('src="https://cdn.example.com/clip.mp4"');
  });

  it("promotes audio/video attachment links into players", () => {
    const html = rewritePreviewAssetUrls(
      '<p><a href="song.mp3">song.mp3</a> and <a href="clip.mp4">clip.mp4</a></p>',
      "/v1/notes/n1/assets?path=",
    );
    expect(html).toContain("<audio");
    expect(html).toContain('src="/v1/notes/n1/assets?path=song.mp3"');
    expect(html).toContain("<video");
    expect(html).toContain('src="/v1/notes/n1/assets?path=clip.mp4"');
    expect(promoteMediaAnchors('<a class="note-link" href="/notes/x">x</a>')).toContain("note-link");
  });
});

describe("note links and backlinks", () => {
  it("rewrites resolved wiki targets and renders 反向链接", () => {
    const html = renderPreviewHtml(
      {
        title: "A",
        path: "A.md",
        hash: "h",
        blocks: [block({ markdown: "see [[B]]", text: "see [[B]]" })],
      },
      {
        links: [{ raw: "[[B]]", label: "B", targetNoteId: "11111111-1111-1111-1111-111111111111" }],
        backlinks: [{ noteId: "22222222-2222-2222-2222-222222222222", title: "来源笔记", path: "src.md" }],
      },
    );
    expect(html).toContain('href="/notes/11111111-1111-1111-1111-111111111111"');
    expect(html).toContain('target="_top"');
    expect(html).toContain("反向链接");
    expect(html).toContain("来源笔记");
    expect(html).toContain('data-preview-style="healing-paper-v8-ink"');
    expect(html).toContain("nh-block");
  });

  it("marks dangling targets distinctly", () => {
    const html = renderPreviewHtml(
      {
        title: "A",
        path: "A.md",
        hash: "h",
        blocks: [block({ markdown: "[[Missing]]", text: "[[Missing]]" })],
      },
      { links: [{ raw: "[[Missing]]", label: "Missing", targetNoteId: null }] },
    );
    expect(html).toContain("#dangling");
    expect(html).toContain("dangling");
  });
});
