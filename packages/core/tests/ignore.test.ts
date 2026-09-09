import { describe, expect, it } from "vitest";
import { shouldIgnore, stripPrefix } from "../src/ignore.ts";
import { obsidianSourceId } from "../src/source-id.ts";
import {
  coveringBigrams,
  queryContentTokens,
  stripCjkQueryStops,
  toFtsTokens,
  toTsQueryTokens,
} from "../src/cjk.ts";
import { encryptSecret, decryptSecret } from "../src/secrets.ts";

describe("ignore", () => {
  it("ignores .obsidian and .trash", () => {
    expect(shouldIgnore(".obsidian/app.json")).toBe(true);
    expect(shouldIgnore(".trash/deleted.md")).toBe(true);
    expect(shouldIgnore("Welcome.md")).toBe(false);
    expect(shouldIgnore("Daily/2026-08-29.md")).toBe(false);
    expect(shouldIgnore("assets/sample.png")).toBe(false);
  });
  it("strips remote prefix", () => {
    expect(stripPrefix("vault1/Welcome.md", "vault1")).toBe("Welcome.md");
    expect(shouldIgnore(stripPrefix("vault1/.obsidian/app.json", "vault1"))).toBe(true);
  });
});

describe("source_id", () => {
  it("uses posix vault path", () => {
    expect(obsidianSourceId("conn_01HX", "Daily/2026-08-29.md")).toBe(
      "obsidian://conn_01HX/Daily/2026-08-29.md",
    );
  });
});

describe("cjk tokens", () => {
  it("emits bigrams", () => {
    const t = toFtsTokens("紫铜灯笼检索词");
    expect(t).toContain("紫铜");
    expect(t).toContain("检索");
  });

  it("index-side keeps all overlapping bigrams including bridges", () => {
    expect(toFtsTokens("搜索二叉树").split(/\s+/)).toEqual([
      "搜索",
      "索二",
      "二叉",
      "叉树",
    ]);
  });

  it("strips Chinese question templates from queries", () => {
    expect(stripCjkQueryStops("什么是感情")).toBe("感情");
    expect(stripCjkQueryStops("感情是什么")).toBe("感情");
    expect(stripCjkQueryStops("请问一下如何理解左值")).toContain("理解");
    expect(stripCjkQueryStops("请问一下如何理解左值")).toContain("左值");
    expect(stripCjkQueryStops("请问一下如何理解左值")).not.toContain("如何");
  });

  it("什么是感情 content tokens emphasize 感情 not 什么/么是", () => {
    const tokens = queryContentTokens("什么是感情");
    expect(tokens).toContain("感情");
    expect(tokens).not.toContain("什么");
    expect(tokens).not.toContain("么是");
    expect(tokens).not.toContain("是感");
    const ts = toTsQueryTokens("什么是感情");
    expect(ts).toBe("感情");
    expect(ts).not.toContain("什么");
  });

  it("stopword stripping for multiple templates", () => {
    const why = queryContentTokens("为什么会这样");
    expect(why).toContain("这样");
    expect(why).not.toContain("为什");
    expect(why).not.toContain("什么");
    expect(queryContentTokens("如何理解 ProtoBuf")).toEqual(
      expect.arrayContaining(["理解", "protobuf"]),
    );
    expect(toTsQueryTokens("什么是左值")).toBe("左值");
    expect(toTsQueryTokens("请问有没有感情")).toBe("感情");
  });

  it("covering bigrams drop interior bridge 索二 for 搜索二叉树", () => {
    expect(coveringBigrams("搜索二叉树")).toEqual(["搜索", "二叉", "叉树"]);
    expect(coveringBigrams("二叉树")).toEqual(["二叉", "叉树"]);
    expect(coveringBigrams("感情")).toEqual(["感情"]);
  });

  it("搜索二叉树 tsquery does not AND-require bridge 索二", () => {
    const content = queryContentTokens("搜索二叉树");
    expect(content).toEqual(["搜索", "二叉", "叉树"]);
    expect(content).not.toContain("索二");
    const ts = toTsQueryTokens("搜索二叉树");
    expect(ts).toBe("搜索 & 二叉 & 叉树");
    expect(ts.split(/\s*&\s*/)).not.toContain("索二");
    // Must not be the old all-overlaps AND that kills recall.
    expect(ts).not.toBe("搜索 & 索二 & 二叉 & 叉树");
  });

  it("二叉树 still emits covering bigrams for retrieval", () => {
    expect(queryContentTokens("二叉树")).toEqual(["二叉", "叉树"]);
    expect(toTsQueryTokens("二叉树")).toBe("二叉 & 叉树");
  });
});

describe("secrets", () => {
  it("roundtrips", () => {
    const blob = encryptSecret("hello", "hub");
    expect(decryptSecret(blob, "hub")).toBe("hello");
  });
});
