import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@note-hub/core";
import { FeishuAdapter } from "../src/feishu.ts";

function ctx(wiki = "spc"): AdapterContext {
  return {
    connection: {
      id: "c1",
      space_id: "s1",
      source: "feishu",
      name: "f",
      config: wiki ? { wiki_space_id: wiki, obj_types: ["docx"] } : { obj_types: ["docx"] },
      secrets_ref: "x",
      cursor: null,
      mode: null,
      status: "active",
      last_sync_at: null,
      last_error: null,
    },
    secrets: { app_id: "cli_x", app_secret: "secret-app" },
    cursor: null,
  };
}

const rootNodes = {
  code: 0,
  data: {
    items: [
      {
        node_token: "n1",
        obj_token: "doxcnAAA",
        obj_type: "docx",
        title: "Doc One",
        has_child: true,
        obj_edit_time: "100",
        parent_node_token: "",
      },
      {
        node_token: "n2",
        obj_token: "shtBBB",
        obj_type: "sheet",
        title: "Sheet Skip",
        has_child: false,
        obj_edit_time: "100",
      },
      {
        node_token: "n3",
        obj_token: "doxcnCCC",
        obj_type: "docx",
        title: "Doc Two",
        has_child: false,
        obj_edit_time: "200",
      },
    ],
    has_more: false,
  },
};

const childNodes = { code: 0, data: { items: [], has_more: false } };

const docBlocks = {
  code: 0,
  data: {
    items: [
      {
        block_id: "b0",
        block_type: 1,
        page: { elements: [{ text_run: { content: "Doc One" } }] },
      },
      {
        block_id: "b1",
        block_type: 3,
        heading1: { elements: [{ text_run: { content: "Hello Feishu" } }] },
      },
      {
        block_id: "b2",
        block_type: 2,
        text: { elements: [{ text_run: { content: "A paragraph from wiki" } }] },
      },
    ],
    has_more: false,
  },
};

function mockFetch(): typeof fetch {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.app_id).toBe("cli_x");
      expect(body.app_secret).toBe("secret-app");
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
    }
    expect(url.startsWith("https://open.feishu.cn/")).toBe(true);
    const h = new Headers(init?.headers);
    expect(h.get("authorization")).toBe("Bearer t-xxx");
    if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
      const u = new URL(url);
      const parent = u.searchParams.get("parent_node_token") ?? "";
      const payload = parent ? childNodes : rootNodes;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (url.includes("/docx/v1/documents/") && url.includes("/blocks")) {
      return new Response(JSON.stringify(docBlocks), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return fetchFn;
}

describe("feishu adapter", () => {
  it("probe 200 vs 401 and code!=0 does not leak secrets", async () => {
    const adapter = new FeishuAdapter(mockFetch());
    const ok = await adapter.probe(ctx());
    expect(ok.ok).toBe(true);

    const fetch401: typeof fetch = async () => new Response("no", { status: 401 });
    const bad = await new FeishuAdapter(fetch401).probe(ctx());
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-app");

    const fetchCode: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 999, msg: "invalid app" }), { status: 200 });
    const coded = await new FeishuAdapter(fetchCode).probe(ctx());
    expect(coded.ok).toBe(false);
    expect(JSON.stringify(coded)).not.toContain("secret-app");
  });

  it("lists 2 docx, skips sheet, fetchNote converts blocks", async () => {
    const adapter = new FeishuAdapter(mockFetch());
    const { changes } = await adapter.listChanges(ctx());
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.source_id).sort()).toEqual(["doxcnAAA", "doxcnCCC"].sort());
    expect(changes.every((c) => c.type === "upsert")).toBe(true);
    expect(changes.some((c) => c.source_id === "shtBBB" || c.source_id === "n1")).toBe(false);

    const note = await adapter.fetchNote(ctx(), "doxcnAAA");
    expect(note).not.toBeNull();
    expect(note!.title).toBe("Doc One");
    const md = String(note!.raw);
    expect(md).toContain("# Hello Feishu");
    expect(md).toContain("A paragraph from wiki");
  });

  it("listChanges empty without wiki_space_id", async () => {
    const adapter = new FeishuAdapter(mockFetch());
    const { changes } = await adapter.listChanges(ctx(""));
    expect(changes).toEqual([]);
  });
});
