import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@note-hub/core";
import { NotionAdapter } from "../src/notion.ts";

const PAGE1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PAGE2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PAGE1_HEX = PAGE1.replace(/-/g, "");
const PAGE2_HEX = PAGE2.replace(/-/g, "");

function ctx(): AdapterContext {
  return {
    connection: {
      id: "c1",
      space_id: "s1",
      source: "notion",
      name: "n",
      config: { workspace_id: "ws" },
      secrets_ref: "x",
      cursor: null,
      mode: null,
      status: "active",
      last_sync_at: null,
      last_error: null,
    },
    secrets: { token: "secret-token" },
    cursor: null,
  };
}

function titleProp(text: string, key = "title") {
  return {
    [key]: {
      type: "title",
      title: [{ type: "text", plain_text: text, text: { content: text } }],
    },
  };
}

const pages = [
  {
    object: "page",
    id: PAGE1,
    last_edited_time: "2026-08-30T12:00:00.000Z",
    archived: false,
    properties: titleProp("Alpha"),
  },
  {
    object: "page",
    id: PAGE2,
    last_edited_time: "2026-08-29T12:00:00.000Z",
    archived: false,
    properties: titleProp("Beta", "Name"),
  },
];

const pageBlocks = {
  object: "list",
  results: [
    {
      object: "block",
      id: "11111111-1111-1111-1111-111111111111",
      type: "heading_1",
      has_children: false,
      heading_1: {
        rich_text: [{ type: "text", plain_text: "Hello Notion", text: { content: "Hello Notion" } }],
      },
    },
    {
      object: "block",
      id: "22222222-2222-2222-2222-222222222222",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          { type: "text", plain_text: "A paragraph of content", text: { content: "A paragraph of content" } },
        ],
      },
    },
  ],
  has_more: false,
  next_cursor: null,
};

function mockFetch(): typeof fetch {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    expect(url.startsWith("https://api.notion.com/")).toBe(true);
    if (url.endsWith("/v1/users/me")) {
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer secret-token");
      expect(h.get("Notion-Version")).toBe("2022-06-28");
      return new Response(JSON.stringify({ object: "user", id: "u1" }), { status: 200 });
    }
    if (url.includes("/v1/search")) {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        filter?: { value?: string };
        page_size?: number;
      };
      expect(body.page_size).toBe(100);
      const value = body.filter?.value;
      if (value === "database") {
        return new Response(JSON.stringify({ object: "list", results: [], has_more: false }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ object: "list", results: pages, has_more: false, next_cursor: null }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/pages/")) {
      const id = url.split("/v1/pages/")[1]?.split("?")[0] ?? "";
      const page = pages.find((p) => p.id.replace(/-/g, "") === id.replace(/-/g, ""));
      if (!page) return new Response(JSON.stringify({ object: "error" }), { status: 404 });
      return new Response(JSON.stringify(page), { status: 200 });
    }
    if (url.includes("/v1/blocks/") && url.includes("/children")) {
      return new Response(JSON.stringify(pageBlocks), { status: 200 });
    }
    if (url.includes("/v1/databases/")) {
      return new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return fetchFn;
}

describe("notion adapter", () => {
  it("probe 200 vs 401 and does not leak secrets", async () => {
    const adapter = new NotionAdapter(mockFetch());
    const ok = await adapter.probe(ctx());
    expect(ok.ok).toBe(true);

    const fetch401: typeof fetch = async () => new Response("unauthorized", { status: 401 });
    const bad = await new NotionAdapter(fetch401).probe(ctx());
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-token");
  });

  it("listChanges two pages and fetchNote markdown", async () => {
    const adapter = new NotionAdapter(mockFetch());
    const { changes, nextCursor } = await adapter.listChanges(ctx());
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.source_id).sort()).toEqual([PAGE1_HEX, PAGE2_HEX].sort());
    expect(changes.every((c) => c.type === "upsert")).toBe(true);
    expect(nextCursor.last_edited_time).toBe("2026-08-30T12:00:00.000Z");

    const note = await adapter.fetchNote(ctx(), PAGE1_HEX);
    expect(note).not.toBeNull();
    expect(note!.title).toBe("Alpha");
    const md = String(note!.raw);
    expect(md).toContain("# Hello Notion");
    expect(md).toContain("A paragraph of content");
  });
});
