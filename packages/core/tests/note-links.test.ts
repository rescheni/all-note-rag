import { describe, expect, it } from "vitest";
import { extractNoteLinkCandidates } from "../src/note-links.ts";
describe("source-native note links", () => {
  it("extracts Obsidian aliases/headings but not embeds", () => expect(extractNoteLinkCandidates("[[Folder/Note#Part|别名]] ![[pic.png]]", "obsidian")).toMatchObject([{ rawTarget: "Folder/Note", label: "别名", heading: "Part", kind: "wiki" }]));
  it("accepts only real SiYuan ids", () => expect(extractNoteLinkCandidates('((20241213101800-kxz5k2w "锚文本")) ((not code))', "siyuan")).toMatchObject([{ nativeId: "20241213101800-kxz5k2w", label: "锚文本" }]));
  it("extracts native page tokens", () => { expect(extractNoteLinkCandidates("[A](https://www.notion.so/x-3ac3a0387be38036a8c5e81df6c30594)", "notion")[0]?.nativeId).toBe("3ac3a0387be38036a8c5e81df6c30594"); expect(extractNoteLinkCandidates("[B](https://acme.feishu.cn/docx/D23Vdh9poonGpNxf1UncBMJPnoQ)", "feishu")[0]?.nativeId).toBe("D23Vdh9poonGpNxf1UncBMJPnoQ"); });
});
