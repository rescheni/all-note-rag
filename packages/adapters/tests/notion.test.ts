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

describe("notion adapter oauth token", () => {
  it("prefers oauth access_token over integration token", async () => {
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ object: "user", id: "u1" }), { status: 200 });
    };
    const adapter = new NotionAdapter(fetchFn);
    const c = ctx();
    c.secrets = { token: "secret-token", access_token: "oauth-access" };
    const ok = await adapter.probe(c);
    expect(ok.ok).toBe(true);
    expect(seen).toEqual(["Bearer oauth-access"]);
  });

  it("token-only still works", async () => {
    const adapter = new NotionAdapter(mockFetch());
    const ok = await adapter.probe(ctx());
    expect(ok.ok).toBe(true);
  });

  it("refreshes on 401 when refresh_token exists", async () => {
    const calls: { url: string; auth: string }[] = [];
    let users = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push({ url, auth });
      if (url.includes("/oauth/token")) {
        expect(auth.startsWith("Basic ")).toBe(true);
        const body = JSON.parse(String(init?.body ?? "{}")) as { grant_type?: string };
        expect(body.grant_type).toBe("refresh_token");
        return new Response(JSON.stringify({ access_token: "oauth-rotated", refresh_token: "refresh-2" }), {
          status: 200,
        });
      }
      if (url.endsWith("/v1/users/me")) {
        users += 1;
        if (auth === "Bearer stale-oauth") {
          return new Response("unauthorized", { status: 401 });
        }
        if (auth === "Bearer oauth-rotated") {
          return new Response(JSON.stringify({ object: "user", id: "u1" }), { status: 200 });
        }
      }
      throw new Error(`unexpected ${url} ${auth}`);
    };
    const persisted: Record<string, string>[] = [];
    const adapter = new NotionAdapter(fetchFn, { clientId: "cid", clientSecret: "csecret" });
    const c = ctx();
    c.secrets = { token: "secret-token", access_token: "stale-oauth", refresh_token: "refresh-1" };
    c.persistSecrets = async (s) => {
      persisted.push({ ...(s as Record<string, string>) });
    };
    const ok = await adapter.probe(c);
    expect(ok.ok).toBe(true);
    expect(users).toBe(2);
    expect(c.secrets?.access_token).toBe("oauth-rotated");
    expect(persisted[0]?.access_token).toBe("oauth-rotated");
    expect(JSON.stringify(ok)).not.toContain("stale-oauth");
    expect(JSON.stringify(ok)).not.toContain("csecret");
    expect(JSON.stringify(calls.map((x) => x.auth))).not.toContain("csecret");
  });
});

describe("notion media asset ingestion", () => {
  const MEDIA_PAGE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const MEDIA_HEX = MEDIA_PAGE.replace(/-/g, "");

  const mediaPage = {
    object: "page",
    id: MEDIA_PAGE,
    last_edited_time: "2026-08-31T12:00:00.000Z",
    archived: false,
    properties: titleProp("Media"),
  };

  const mediaBlocks = {
    object: "list",
    has_more: false,
    next_cursor: null,
    results: [
      {
        object: "block",
        id: "aaaa1111-1111-1111-1111-111111111111",
        type: "video",
        has_children: false,
        video: { type: "file", file: { url: "https://files.notion.example/clip.mp4?sig=1" } },
      },
      {
        object: "block",
        id: "bbbb2222-2222-2222-2222-222222222222",
        type: "audio",
        has_children: false,
        audio: { type: "external", external: { url: "https://cdn.example.com/voice.mp3" } },
      },
      {
        object: "block",
        id: "cccc3333-3333-3333-3333-333333333333",
        type: "video",
        has_children: false,
        video: { type: "external", external: { url: "https://www.youtube.com/watch?v=abc123" } },
      },
      {
        object: "block",
        id: "dddd4444-4444-4444-4444-444444444444",
        type: "audio",
        has_children: false,
        audio: { type: "external", external: { url: "https://cdn.example.com/missing.mp3" } },
      },
      {
        object: "block",
        id: "eeee5555-5555-5555-5555-555555555555",
        type: "embed",
        has_children: false,
        embed: { url: "https://example.com/board" },
      },
    ],
  };

  function mediaFetch(): typeof fetch {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/users/me")) {
        return new Response(JSON.stringify({ object: "user", id: "u1" }), { status: 200 });
      }
      if (url.includes("/v1/pages/")) return new Response(JSON.stringify(mediaPage), { status: 200 });
      if (url.includes("/v1/blocks/") && url.includes("/children")) {
        return new Response(JSON.stringify(mediaBlocks), { status: 200 });
      }
      if (url.startsWith("https://files.notion.example/clip.mp4")) {
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      if (url.startsWith("https://cdn.example.com/voice.mp3")) {
        return new Response(new Uint8Array([73, 68, 51, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      // A YouTube watch page is a page, not a media file.
      if (url.startsWith("https://www.youtube.com/watch")) {
        return new Response("<!DOCTYPE html><html><body>yt</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // A 404 attachment must not fail the note.
      if (url.startsWith("https://cdn.example.com/missing.mp3")) {
        return new Response("nope", { status: 404 });
      }
      throw new Error(`unexpected url ${url}`);
    };
    return fetchFn;
  }

  it("downloads video + audio into assets and links them from the markdown", async () => {
    const adapter = new NotionAdapter(mediaFetch());
    const note = await adapter.fetchNote(ctx(), MEDIA_HEX);
    expect(note).not.toBeNull();

    const names = (note!.assets ?? []).map((a) => a.path).sort();
    expect(names).toEqual(["clip.mp4", "voice.mp3"]);

    const md = String(note!.raw);
    // Signed/external urls were swapped for the stored asset names.
    expect(md).toContain('<video controls src="clip.mp4"></video>');
    expect(md).toContain('<audio controls src="voice.mp3"></audio>');
    // Non-downloadable references still survive as links.
    expect(md).toContain("https://www.youtube.com/watch?v=abc123");
    expect(md).toContain("https://example.com/board");
  });

  it("a 404 / html-page media block is skipped, not fatal", async () => {
    const adapter = new NotionAdapter(mediaFetch());
    const note = await adapter.fetchNote(ctx(), MEDIA_HEX);
    expect(note).not.toBeNull();
    const names = (note!.assets ?? []).map((a) => a.path);
    expect(names).not.toContain("missing.mp3");
    expect(names).not.toContain("watch");
  });
});

describe("notion hierarchy paths", () => {
  it("walks page/database parents, caches ancestors, escapes title slashes, and tolerates inaccessible parents", async () => {
    const ROOT = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const DB = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const CHILD = "33333333-cccc-cccc-cccc-cccccccccccc";
    const MISSING_PARENT = "44444444-dddd-dddd-dddd-dddddddddddd";
    const ORPHAN = "55555555-eeee-eeee-eeee-eeeeeeeeeeee";
    const calls = new Map<string, number>();
    const objects: Record<string, Record<string, unknown>> = {
      [ROOT.replaceAll("-", "")]: { object: "page", id: ROOT, parent: { type: "workspace", workspace: true }, properties: titleProp("示例知识库 / Wiki samples") },
      [DB.replaceAll("-", "")]: { object: "database", id: DB, parent: { type: "page_id", page_id: ROOT }, title: [{ plain_text: "Projects" }] },
      [CHILD.replaceAll("-", "")]: { object: "page", id: CHILD, parent: { type: "database_id", database_id: DB }, properties: titleProp("API / Design") },
      [ORPHAN.replaceAll("-", "")]: { object: "page", id: ORPHAN, parent: { type: "page_id", page_id: MISSING_PARENT }, properties: titleProp("Still here") },
    };
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      const id = url.split("/").pop() ?? "";
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url.includes("/databases/")) {
        const obj = objects[id];
        return new Response(JSON.stringify(obj ?? { object: "error" }), { status: obj?.object === "database" ? 200 : 404 });
      }
      if (url.includes("/pages/")) {
        const obj = objects[id];
        return new Response(JSON.stringify(obj ?? { object: "error" }), { status: obj?.object === "page" ? 200 : 404 });
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = new NotionAdapter(fetchFn);
    const childPath = await adapter.resolvePath(ctx(), CHILD);
    expect(childPath).toBe("n/示例知识库 ／ Wiki samples/Projects/API ／ Design");
    expect(await adapter.resolvePath(ctx(), CHILD)).toBe(childPath);
    expect([...calls.entries()].filter(([url]) => url.includes(ROOT.replaceAll("-", "")))).toHaveLength(1);
    expect(await adapter.resolvePath(ctx(), ORPHAN)).toBe("[无法访问的页面-44444444]/Still here");
  });

  it("guards parent cycles", async () => {
    const A = "66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const B = "77777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const objects: Record<string, Record<string, unknown>> = {
      [A.replaceAll("-", "")]: { object: "page", id: A, parent: { type: "page_id", page_id: B }, properties: titleProp("A") },
      [B.replaceAll("-", "")]: { object: "page", id: B, parent: { type: "page_id", page_id: A }, properties: titleProp("B") },
    };
    const fetchFn: typeof fetch = async (input) => {
      const obj = objects[String(input).split("/").pop() ?? ""];
      return new Response(JSON.stringify(obj ?? { object: "error" }), { status: obj ? 200 : 404 });
    };
    expect(await new NotionAdapter(fetchFn).resolvePath(ctx(), A)).toBe("[无法访问的循环父级-66666666]/B/A");
  });
});
