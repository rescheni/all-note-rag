import { describe, expect, it } from "vitest";
import { shouldIgnore, stripPrefix } from "../src/ignore.ts";
import { obsidianSourceId } from "../src/source-id.ts";
import { toFtsTokens } from "../src/cjk.ts";
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
});

describe("secrets", () => {
  it("roundtrips", () => {
    const blob = encryptSecret("hello", "hub");
    expect(decryptSecret(blob, "hub")).toBe("hello");
  });
});
