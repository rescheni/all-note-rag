import { describe, expect, it } from "vitest";
import { siyuanIconToEmoji } from "../src/icon.ts";

describe("siyuanIconToEmoji", () => {
  it("converts hyphen-separated hex codepoints", () => {
    expect(siyuanIconToEmoji("1f618")).toBe("😘");
    expect(siyuanIconToEmoji("1f44b")).toBe("👋");
    expect(siyuanIconToEmoji("1f6f3-fe0f")).toBe("🛳️");
    expect(siyuanIconToEmoji("1f1f0-1f1ec")).toBe("🇰🇬");
  });

  it("passes through already-emoji strings", () => {
    expect(siyuanIconToEmoji("🚢")).toBe("🚢");
    expect(siyuanIconToEmoji(" 👋 ")).toBe("👋");
  });

  it("skips invalid parts and empty input", () => {
    expect(siyuanIconToEmoji("")).toBe("");
    expect(siyuanIconToEmoji("   ")).toBe("");
    expect(siyuanIconToEmoji("zzzzzz")).toBe("zzzzzz");
  });
});
