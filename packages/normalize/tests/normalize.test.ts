import { describe, expect, it } from "vitest";
import { extractBlocks, extractLinks, normalizeObsidianNote, parseFrontmatter, stableMarkdown } from "../src/index.ts";

const daily = `---
date: 2026-08-29
tags:
  - daily
---

# 2026-08-29

See [[Welcome]] and [site](https://example.com).

![[assets/sample.png]]
`;

describe("frontmatter", () => {
  it("lowercases keys", () => {
    const { frontmatter, body } = parseFrontmatter(daily);
    expect(frontmatter.date).toBe("2026-08-29");
    expect(body).toContain("# 2026-08-29");
  });
});

describe("wiki links", () => {
  it("extracts wiki and markdown links", () => {
    const links = extractLinks(daily, "Daily/2026-08-29.md", "c1");
    const kinds = links.map((l) => l.kind);
    expect(kinds).toContain("ref");
    expect(kinds).toContain("embed");
    expect(kinds).toContain("url");
    expect(links.some((l) => l.to_source_id?.includes("Welcome.md"))).toBe(true);
  });
});

describe("hash stability", () => {
  it("same content same hash regardless of key order", () => {
    const a = stableMarkdown({ z: 1, a: 2 }, "hello\n");
    const b = stableMarkdown({ a: 2, z: 1 }, "hello\r\n");
    const na = normalizeObsidianNote(
      { source_id: "obsidian://c1/a.md", path: "a.md", title: "a", raw: a },
      "c1",
    );
    const nb = normalizeObsidianNote(
      { source_id: "obsidian://c1/a.md", path: "a.md", title: "a", raw: b },
      "c1",
    );
    expect(na.hash).toBe(nb.hash);
    expect(na.markdown.endsWith("\n")).toBe(true);
  });
});

describe("blocks", () => {
  it("assigns heading path + fingerprint ids", () => {
    const blocks = extractBlocks("# Hi\n\npara one\n");
    expect(blocks[0].type).toBe("heading");
    expect(blocks[1].type).toBe("para");
    expect(blocks[1].source_block_id).toMatch(/hi\/para0-/);
  });
});

describe("skipped heading levels", () => {
  it("does not throw when a note starts at h3 or jumps h1 -> h3", () => {
    // `headingPath.length = depth - 1` used to leave undefined holes, which crashed
    // slugPart() and failed the entire note ingest.
    const blocks = extractBlocks("### Deep start\n\nbody text\n");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.type === "heading")).toBe(true);
    expect(blocks.every((b) => typeof b.source_block_id === "string" && b.source_block_id.length > 0)).toBe(true);

    const jump = extractBlocks("# One\n\n#### Four\n\nbody\n");
    expect(jump.some((b) => b.markdown === "body")).toBe(true);
    expect(jump.every((b) => !b.source_block_id.includes("undefined"))).toBe(true);
  });
});
