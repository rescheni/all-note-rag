import { describe, expect, it } from "vitest";
import { renderPreviewHtml, rewritePreviewAssetUrls } from "../src/index.ts";

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
