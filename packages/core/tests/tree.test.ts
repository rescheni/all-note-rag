import { describe, expect, it } from "vitest";
import { buildFileTree, expandTreeLevels, isAssetNoteId } from "../src/tree.ts";

describe("isAssetNoteId", () => {
  it("matches SiYuan asset-note source ids", () => {
    expect(isAssetNoteId("asset:assets/foo.jpeg")).toBe(true);
    expect(isAssetNoteId("asset:20241211071716-w11cbza:assets/foo.jpeg")).toBe(true);
    expect(isAssetNoteId("20241211214233-uokc9hs")).toBe(false);
    expect(isAssetNoteId(undefined)).toBe(false);
  });
});

describe("buildFileTree", () => {
  it("nests folders, notes and assets; keeps folders that only have assets", () => {
    const tree = buildFileTree([
      { path: "Daily/2026-08-29.md", kind: "note", note_id: "n1", source: "obsidian" },
      { path: "Welcome.md", kind: "note", note_id: "n2", source: "obsidian" },
      { path: "assets/sample.png", kind: "asset", asset_id: "a1", note_id: "n2", note_path: "Welcome.md", source: "obsidian" },
      { path: "inbox/only.pdf", kind: "asset", asset_id: "a2", note_id: "n3", source: "feishu" },
    ]);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["Daily", "Welcome.md", "inbox"].sort());
    const daily = tree.find((n) => n.name === "Daily");
    expect(daily?.kind).toBe("folder");
    expect(daily?.children?.[0]).toMatchObject({ kind: "note", name: "2026-08-29.md", note_id: "n1" });
    expect(tree.find((n) => n.name === "assets")).toBeUndefined();
    const inbox = tree.find((n) => n.name === "inbox");
    expect(inbox?.kind).toBe("folder");
    expect(inbox?.children?.[0]).toMatchObject({ kind: "asset", name: "only.pdf" });
    const welcome = tree.find((n) => n.name === "Welcome.md");
    expect(welcome?.kind).toBe("note");
    expect(welcome?.children?.some((c) => c.kind === "asset" && c.name === "sample.png")).toBe(true);
  });

  it("does not duplicate an asset already under the note folder", () => {
    const tree = buildFileTree([
      { path: "folder/note.md", kind: "note", note_id: "n1" },
      { path: "folder/pic.png", kind: "asset", asset_id: "a1", note_id: "n1", note_path: "folder/note.md" },
    ]);
    const folder = tree.find((n) => n.name === "folder");
    const kinds = (folder?.children ?? []).map((c) => `${c.kind}:${c.name}`).sort();
    expect(kinds).toEqual(["asset:pic.png", "note:note.md"]);
    const note = folder?.children?.find((c) => c.kind === "note");
    expect(note?.children ?? []).toEqual([]);
  });

  it("nests a .sy document that also has children as both note and folder", () => {
    const tree = buildFileTree([
      {
        path: "20241211071716-w11cbza/20241211214233-uokc9hs.sy",
        kind: "note",
        note_id: "parent",
        title: "父文档",
        source: "siyuan",
        connection_id: "c1",
        connection_name: "我的思源",
      },
      {
        path: "20241211071716-w11cbza/20241211214233-uokc9hs.sy/20241212000000-child.sy",
        kind: "note",
        note_id: "child",
        title: "子文档",
        source: "siyuan",
        connection_id: "c1",
        connection_name: "我的思源",
      },
    ]);
    const box = tree.find((n) => n.path === "20241211071716-w11cbza");
    expect(box?.kind).toBe("folder");
    expect(box?.name).toBe("笔记本");
    const parent = box?.children?.find((c) => c.note_id === "parent");
    expect(parent?.kind).toBe("note");
    expect(parent?.name).toBe("父文档");
    expect(parent?.path).toBe("20241211071716-w11cbza/20241211214233-uokc9hs.sy");
    expect(parent?.children?.some((c) => c.note_id === "child" && c.name === "子文档")).toBe(true);
  });

  it("uses note.title as the leaf display name and maps SiYuan box ids", () => {
    const tree = buildFileTree(
      [
        {
          path: "data/20241211071716-w11cbza/20241211214233-uokc9hs.sy",
          kind: "note",
          note_id: "n1",
          title: "开箱笔记",
          source: "siyuan",
        },
      ],
      { boxNames: { "20241211071716-w11cbza": "生活" } },
    );
    expect(tree.map((n) => n.name)).toEqual(["生活"]);
    expect(tree[0]?.path).toBe("data/20241211071716-w11cbza");
    expect(tree[0]?.children?.[0]).toMatchObject({
      kind: "note",
      name: "开箱笔记",
      note_id: "n1",
      path: "data/20241211071716-w11cbza/20241211214233-uokc9hs.sy",
    });
  });

  it("maps first path segment via boxNames (面试 etc.) and parent.sy title", () => {
    const tree = buildFileTree(
      [
        {
          path: "20210808180117-interview/20241211214233-uokc9hs.sy",
          kind: "note",
          note_id: "parent",
          title: "面试准备",
          source: "siyuan",
        },
        {
          path: "20210808180117-interview/20241211214233-uokc9hs.sy/20241212000000-child.sy",
          kind: "note",
          note_id: "child",
          title: "算法题",
          source: "siyuan",
        },
      ],
      { boxNames: { "20210808180117-interview": "面试" } },
    );
    expect(tree[0]?.name).toBe("面试");
    const parent = tree[0]?.children?.[0];
    expect(parent?.name).toBe("面试准备");
    expect(parent?.name.endsWith(".sy")).toBe(false);
    expect(parent?.children?.[0]?.name).toBe("算法题");
  });

  it("excludes asset-notes and does not dump a root-level assets/ folder for them", () => {
    const tree = buildFileTree(
      [
        {
          path: "20210808180117-czj9bvb/doc.sy",
          kind: "note",
          note_id: "real",
          title: "真笔记",
          source: "siyuan",
          source_id: "20241211214233-uokc9hs",
        },
        {
          path: "assets/foo.jpeg",
          kind: "note",
          note_id: "an1",
          title: "foo.jpeg",
          source: "siyuan",
          source_id: "asset:assets/foo.jpeg",
        },
        {
          path: "assets/foo.jpeg",
          kind: "asset",
          asset_id: "a-orphan",
          note_id: "an1",
          note_path: "assets/foo.jpeg",
          note_source_id: "asset:assets/foo.jpeg",
          source: "siyuan",
        },
        {
          path: "assets/attached.png",
          kind: "asset",
          asset_id: "a-real",
          note_id: "real",
          note_path: "20210808180117-czj9bvb/doc.sy",
          source: "siyuan",
        },
      ],
      { boxNames: { "20210808180117-czj9bvb": "面试" } },
    );
    expect(tree.some((n) => n.name === "assets" || n.path === "assets" || n.path.startsWith("assets/"))).toBe(false);
    expect(tree.find((n) => n.note_id === "an1")).toBeUndefined();
    const box = tree.find((n) => n.name === "面试");
    expect(box).toBeTruthy();
    const note = box?.children?.find((c) => c.note_id === "real");
    expect(note?.name).toBe("真笔记");
    expect(note?.children?.some((c) => c.kind === "asset" && c.name === "attached.png")).toBe(true);
  });

  it("groups by connection/source as top folders", () => {
    const tree = buildFileTree(
      [
        {
          path: "Daily/a.md",
          kind: "note",
          note_id: "o1",
          title: "日记",
          source: "obsidian",
          connection_id: "c-ob",
          connection_name: "Obsidian",
        },
        {
          path: "wiki/team/spec",
          kind: "note",
          note_id: "f1",
          title: "规格",
          source: "feishu",
          connection_id: "c-fs",
          connection_name: "飞书",
        },
        {
          path: "Pages/Home",
          kind: "note",
          note_id: "n1",
          title: "主页",
          source: "notion",
          connection_id: "c-nt",
          connection_name: "Notion",
        },
        {
          path: "20241211071716-w11cbza/doc.sy",
          kind: "note",
          note_id: "s1",
          title: "文档",
          source: "siyuan",
          connection_id: "c-sy",
          connection_name: "我的思源",
        },
      ],
      {
        groupBySource: true,
        boxNamesByConnection: { "c-sy": { "20241211071716-w11cbza": "生活" } },
      },
    );
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["Notion", "Obsidian", "我的思源", "飞书"].sort());
    const sy = tree.find((n) => n.name === "我的思源");
    expect(sy?.kind).toBe("folder");
    expect(sy?.path).toBe("conn:c-sy");
    expect(sy?.children?.[0]?.name).toBe("生活");
    expect(sy?.children?.[0]?.children?.[0]?.name).toBe("文档");
    const ob = tree.find((n) => n.name === "Obsidian");
    expect(ob?.children?.[0]?.name).toBe("Daily");
    expect(ob?.children?.[0]?.children?.[0]?.name).toBe("日记");
    const fs = tree.find((n) => n.name === "飞书");
    expect(fs?.children?.[0]?.name).toBe("wiki");
    const nt = tree.find((n) => n.name === "Notion");
    expect(nt?.children?.[0]?.children?.[0]?.name).toBe("主页");
  });

  it("expandTreeLevels opens the first two depths", () => {
    const tree = buildFileTree(
      [
        { path: "A/B/c.md", kind: "note", note_id: "n1", title: "C", connection_id: "c1", connection_name: "源" },
      ],
      { groupBySource: true },
    );
    const open = expandTreeLevels(tree, 2);
    expect(open.has("conn:c1")).toBe(true);
    expect(open.has("A")).toBe(true);
    expect(open.has("A/B")).toBe(false);
  });

  it("expandTreeLevels does not auto-open assets folders", () => {
    const tree = buildFileTree(
      [
        { path: "Daily/a.md", kind: "note", note_id: "n1", title: "A", connection_id: "c1", connection_name: "源" },
        { path: "inbox/only.pdf", kind: "asset", asset_id: "a1", note_id: "n2", connection_id: "c1", connection_name: "源" },
      ],
      { groupBySource: true },
    );
    const open = expandTreeLevels(tree, 2);
    expect(open.has("conn:c1")).toBe(true);
    expect(open.has("Daily")).toBe(true);
    expect(open.has("inbox")).toBe(true);
    const withAssets = [
      {
        name: "源",
        path: "conn:c1",
        kind: "folder" as const,
        children: [
          { name: "assets", path: "assets", kind: "folder" as const, children: [{ name: "foo.jpeg", path: "assets/foo.jpeg", kind: "asset" as const }] },
        ],
      },
    ];
    const skipped = expandTreeLevels(withAssets, 2);
    expect(skipped.has("conn:c1")).toBe(true);
    expect(skipped.has("assets")).toBe(false);
  });

  it("merges box-name and box-id prefixes into one notebook", () => {
    const boxNames = { "20241211085005-ubtel98": "only code" };
    const tree = buildFileTree(
      [
        { path: "only code/foo.sy", kind: "note", note_id: "n1", title: "Foo", source: "siyuan" },
        { path: "20241211085005-ubtel98/bar.sy", kind: "note", note_id: "n2", title: "Bar", source: "siyuan" },
      ],
      { boxNames },
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("only code");
    expect(tree[0]?.path).toBe("20241211085005-ubtel98");
    const names = (tree[0]?.children ?? []).map((c) => c.name).sort();
    expect(names).toEqual(["Bar", "Foo"]);
    expect(tree.some((n) => n.name === "only code" && n.path === "only code")).toBe(false);
  });

  it("displays parent title for id.sy child folders, not the id", () => {
    const boxNames = { "20241211085005-ubtel98": "only code" };
    const tree = buildFileTree(
      [
        {
          path: "20241211085005-ubtel98/20241211210944-59k7qbs.sy",
          kind: "note",
          note_id: "p",
          title: "父文档",
          source: "siyuan",
        },
        {
          path: "only code/20241211210944-59k7qbs.sy/child.sy",
          kind: "note",
          note_id: "c",
          title: "子文档",
          source: "siyuan",
        },
      ],
      { boxNames },
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("only code");
    const parent = tree[0]?.children?.find((c) => c.note_id === "p" || c.name === "父文档");
    expect(parent?.name).toBe("父文档");
    expect(parent?.name).not.toMatch(/^\d{14}-/);
    expect(parent?.children?.some((c) => c.note_id === "c" && c.name === "子文档")).toBe(true);
    const names: string[] = [];
    const walk = (nodes: { name: string; children?: unknown[] }[]) => {
      for (const n of nodes) {
        names.push(n.name);
        if (n.children) walk(n.children as { name: string; children?: unknown[] }[]);
      }
    };
    walk(tree);
    for (const name of names) {
      expect(name).not.toMatch(/^\d{14}-[0-9a-z]+(\.sy)?$/i);
    }
  });

  it("nests vault-root assets under a real .sy note and drops orphans", () => {
    const tree = buildFileTree(
      [
        {
          path: "20241211071716-w11cbza/doc.sy",
          kind: "note",
          note_id: "n1",
          title: "文档",
          source: "siyuan",
        },
        {
          path: "assets/00001-abc.jpeg",
          kind: "asset",
          asset_id: "a1",
          note_id: "n1",
          note_path: "20241211071716-w11cbza/doc.sy",
          source: "siyuan",
        },
        {
          path: "assets/00002-orphan.jpeg",
          kind: "asset",
          asset_id: "a2",
          source: "siyuan",
        },
      ],
      { boxNames: { "20241211071716-w11cbza": "面试" } },
    );
    expect(tree.some((n) => n.name === "assets" || n.path === "assets" || n.path.startsWith("assets/"))).toBe(false);
    expect(JSON.stringify(tree).includes("00002-orphan")).toBe(false);
    const note = tree.find((n) => n.name === "面试")?.children?.find((c) => c.note_id === "n1");
    expect(note?.name).toBe("文档");
    expect(note?.children?.some((c) => c.kind === "asset" && c.name === "00001-abc.jpeg")).toBe(true);
  });

  it("excludes image-named notes from the tree", () => {
    const tree = buildFileTree(
      [
        { path: "20241211071716-w11cbza/doc.sy", kind: "note", note_id: "n1", title: "文档", source: "siyuan" },
        { path: "20241211071716-w11cbza/pic.jpeg", kind: "note", note_id: "img", title: "pic.jpeg", source: "siyuan" },
        { path: "assets/00001-x.png", kind: "note", note_id: "img2", title: "00001-x.png", source: "siyuan" },
      ],
      { boxNames: { "20241211071716-w11cbza": "面试" } },
    );
    expect(tree.find((n) => n.name === "面试")?.children?.some((c) => c.note_id === "n1")).toBe(true);
    expect(JSON.stringify(tree)).not.toMatch(/pic\.jpeg|00001-x/);
  });
  it("live-like mixed box-name and box-id paths keep named notebooks, not empty/ids/assets", () => {
    const boxNames = {
      "20241211071716-w11cbza": "面试",
      "20241211085005-ubtel98": "only code",
      "20241211233443-wwxv837": "read",
      "20241212002428-q664r9w": "PhoneNote",
      "20241212150124-7ot4bs0": "DailyLife",
      "20241217132558-tjx1t52": "杂项",
      "20250101215418-rbj176o": "Memory",
      "20250105192158-z5zm9xi": "垃圾桶",
      "20250131185944-esvch52": "Books",
      "20250417194009-hz28pew": "memos",
      "20250526102040-10gmhry": "日程管理笔记本",
    };
    const conn = { source: "siyuan" as const, connection_id: "c-sy", connection_name: "我的思源" };
    const items = [
      { path: "面试/20241211214233-uokc9hs.sy", kind: "note" as const, note_id: "n-mianshi", title: "面试准备", ...conn },
      { path: "20241211071716-w11cbza/other.sy", kind: "note" as const, note_id: "n-mianshi-2", title: "题解", ...conn },
      { path: "only code/foo.sy", kind: "note" as const, note_id: "n-code-name", title: "Foo", ...conn },
      { path: "20241211085005-ubtel98/bar.sy", kind: "note" as const, note_id: "n-code-id", title: "Bar", ...conn },
      { path: "read/a.sy", kind: "note" as const, note_id: "n-read", title: "阅读", ...conn },
      { path: "PhoneNote/p.sy", kind: "note" as const, note_id: "n-phone", title: "电话", ...conn },
      { path: "20241212150124-7ot4bs0/d.sy", kind: "note" as const, note_id: "n-life", title: "日常", ...conn },
      { path: "杂项/z.sy", kind: "note" as const, note_id: "n-misc", title: "杂记", ...conn },
      { path: "Memory/m.sy", kind: "note" as const, note_id: "n-mem", title: "回忆", ...conn },
      { path: "20250105192158-z5zm9xi/t.sy", kind: "note" as const, note_id: "n-trash", title: "废弃", ...conn },
      { path: "Books/b.sy", kind: "note" as const, note_id: "n-books", title: "书摘", ...conn },
      { path: "memos/x.sy", kind: "note" as const, note_id: "n-memos", title: "备忘", ...conn },
      { path: "20250526102040-10gmhry/s.sy", kind: "note" as const, note_id: "n-cal", title: "日程", ...conn },
      { path: "assets/00001-abc.jpeg", kind: "note" as const, note_id: "an1", title: "00001-abc.jpeg", source_id: "asset:assets/00001-abc.jpeg", ...conn },
      { path: "assets/00001-abc.jpeg", kind: "asset" as const, asset_id: "a1", note_id: "an1", note_path: "assets/00001-abc.jpeg", note_source_id: "asset:assets/00001-abc.jpeg", ...conn },
      { path: "assets/shot.png", kind: "asset" as const, asset_id: "a2", note_id: "n-code-id", note_path: "20241211085005-ubtel98/bar.sy", ...conn },
      { path: "only code/pic.jpeg", kind: "note" as const, note_id: "img", title: "pic.jpeg", ...conn },
    ];
    const tree = buildFileTree(items, { groupBySource: true, boxNamesByConnection: { "c-sy": boxNames } });
    expect(tree.length).toBeGreaterThan(0);
    const sy = tree.find((n) => n.name === "我的思源");
    expect(sy).toBeTruthy();
    const names = (sy?.children ?? []).map((c) => c.name).sort();
    expect(names).not.toHaveLength(0);
    expect(names).toEqual(
      ["Books", "DailyLife", "Memory", "PhoneNote", "memos", "only code", "read", "日程管理笔记本", "垃圾桶", "杂项", "面试"].sort(),
    );
    for (const name of names) {
      expect(name).not.toMatch(/^\d{14}-[0-9a-z]+(\.sy)?$/i);
    }
    expect(names).not.toContain("assets");
    expect(names).not.toContain("附件");
    expect(JSON.stringify(sy).includes("00001-abc")).toBe(false);
    expect(JSON.stringify(sy).includes("pic.jpeg")).toBe(false);
    const code = sy?.children?.find((c) => c.name === "only code");
    expect(code?.children?.some((c) => c.name === "Foo")).toBe(true);
    expect(code?.children?.some((c) => c.name === "Bar")).toBe(true);
  });

  it("id-only SiYuan paths still show boxNames, never an empty first level", () => {
    const boxNames = { "20241211085005-ubtel98": "only code", "20241211071716-w11cbza": "面试" };
    const tree = buildFileTree(
      [
        { path: "20241211085005-ubtel98/foo.sy", kind: "note", note_id: "n1", title: "Foo", source: "siyuan" },
        { path: "20241211071716-w11cbza/bar.sy", kind: "note", note_id: "n2", title: "Bar", source: "siyuan" },
        { path: "assets/x.png", kind: "note", note_id: "img", title: "x.png", source: "siyuan", source_id: "asset:assets/x.png" },
      ],
      { boxNames },
    );
    expect(tree.map((n) => n.name).sort()).toEqual(["only code", "面试"].sort());
    expect(tree).toHaveLength(2);
  });

  it("name-only SiYuan paths stay visible when boxNames cannot reverse-map", () => {
    const tree = buildFileTree(
      [
        { path: "only code/foo.sy", kind: "note", note_id: "n1", title: "Foo", source: "siyuan" },
        { path: "面试/bar.sy", kind: "note", note_id: "n2", title: "Bar", source: "siyuan" },
        { path: "assets/x.png", kind: "asset", asset_id: "a1", source: "siyuan" },
      ],
      { boxNames: {} },
    );
    expect(tree.map((n) => n.name).sort()).toEqual(["only code", "面试"].sort());
    expect(tree.some((n) => n.name === "assets")).toBe(false);
  });
});
