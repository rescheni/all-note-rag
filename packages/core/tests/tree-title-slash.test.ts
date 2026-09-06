import { describe, expect, it } from "vitest";
import { buildSourceGroups } from "../src/tree";

/**
 * Feishu wiki nodes carry bilingual titles: `示例知识库 / Wiki samples`.
 * The slash inside a title must not become a folder boundary.
 */
describe("bilingual titles keep one path segment", () => {
  const conn = { id: "c1", source: "feishu", name: "我的飞书" };
  const items = [
    {
      path: "示例知识库 / Wiki samples/成员手册 / Member Manual",
      kind: "note" as const,
      note_id: "n1",
      title: "成员手册 / Member Manual",
      source: "feishu",
      connection_id: "c1",
    },
    {
      path: "示例知识库 / Wiki samples/成员手册 / Member Manual/权限介绍 / Access permissions",
      kind: "note" as const,
      note_id: "n2",
      title: "权限介绍 / Access permissions",
      source: "feishu",
      connection_id: "c1",
    },
    {
      path: "示例知识库 / Wiki samples/欢迎使用知识库 / Welcome to Wiki",
      kind: "note" as const,
      note_id: "n3",
      title: "欢迎使用知识库 / Welcome to Wiki",
      source: "feishu",
      connection_id: "c1",
    },
  ];

  it("keeps one root named after the whole wiki title", () => {
    const [group] = buildSourceGroups(items, { connections: [conn] });
    expect(group.tree).toHaveLength(1);
    expect(group.tree[0].name).toBe("示例知识库 / Wiki samples");
    expect(group.tree[0].path).toBe("示例知识库 / Wiki samples");
  });

  it("nests the real children instead of half-title folders", () => {
    const [group] = buildSourceGroups(items, { connections: [conn] });
    const kids = group.tree[0].children ?? [];
    expect(kids.map((k) => k.name).sort()).toEqual(
      ["成员手册 / Member Manual", "欢迎使用知识库 / Welcome to Wiki"].sort(),
    );
    const manual = kids.find((k) => k.name === "成员手册 / Member Manual");
    expect(manual?.children?.[0].name).toBe("权限介绍 / Access permissions");
  });

  it("still splits ordinary paths", () => {
    const [group] = buildSourceGroups(
      [{ path: "Daily/2026-08-29.md", kind: "note" as const, note_id: "n4", title: "2026-08-29", source: "obsidian", connection_id: "o1" }],
      { connections: [{ id: "o1", source: "obsidian", name: "我的 Obsidian" }] },
    );
    expect(group.tree[0].name).toBe("Daily");
    expect(group.tree[0].children?.[0].name).toBe("2026-08-29");
  });
});
