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


describe("feishu file nodes", () => {
  it("lists wiki file type as a change", async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  node_token: "n-file",
                  obj_token: "fileTOKEN",
                  obj_type: "file",
                  title: "invoice.pdf",
                  has_child: false,
                  obj_edit_time: "9",
                },
                {
                  node_token: "n-sheet",
                  obj_token: "shtSKIP",
                  obj_type: "sheet",
                  title: "Sheet",
                  has_child: false,
                  obj_edit_time: "9",
                },
              ],
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url} ${init?.method}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const { changes } = await adapter.listChanges(ctx());
    expect(changes.some((c) => c.source_id === "fileTOKEN" && c.path?.includes("invoice.pdf"))).toBe(true);
    expect(changes.some((c) => c.source_id === "shtSKIP")).toBe(false);
  });
});

describe("feishu listContacts", () => {
  it("walks departments and dedupes users; skips no-email at parse if resigned", async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer t-xxx");
      if (url.includes("/contact/v3/departments/0/children")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [{ open_department_id: "od-eng", name: "研发" }],
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/contact/v3/scopes")) {
        return new Response(
          JSON.stringify({ code: 0, data: { department_ids: ["od-eng"], user_ids: [], has_more: false } }),
          { status: 200 },
        );
      }
      if (url.includes("/contact/v3/users/find_by_department")) {
        const u = new URL(url);
        const dept = u.searchParams.get("department_id");
        const items =
          dept === "0"
            ? [
                {
                  open_id: "ou_root",
                  email: "owner@ex.com",
                  name: "主",
                },
              ]
            : [
                { open_id: "ou_match", email: "Match@Ex.com", name: "配" },
                { open_id: "ou_root", email: "owner@ex.com", name: "主" },
                { open_id: "ou_none", name: "无邮箱" },
                { open_id: "ou_gone", email: "gone@ex.com", status: { is_resigned: true } },
              ];
        return new Response(JSON.stringify({ code: 0, data: { items, has_more: false } }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const people = await adapter.listContacts(ctx());
    const ids = people.map((p) => p.open_id).sort();
    expect(ids).toEqual(["ou_match", "ou_none", "ou_root"]);
    expect(people.find((p) => p.open_id === "ou_match")?.email).toBe("match@ex.com");
    expect(people.find((p) => p.open_id === "ou_none")?.email).toBeNull();
    expect(people.some((p) => p.open_id === "ou_gone")).toBe(false);
  });
});
