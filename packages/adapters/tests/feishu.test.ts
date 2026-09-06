import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@note-hub/core";
import { FeishuAdapter } from "../src/feishu.ts";

function ctx(wiki = "1234567890"): AdapterContext {
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

describe("feishu wiki node token", () => {
  it("get_node alone is not enough: space 131006 surfaces Chinese error (no silent About Me)", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/wiki/v2/spaces/get_node")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              node: {
                node_token: "MICpwZMBUiIOtrkjmbJcyiHWnbf",
                obj_token: "GxF7d5ipxoAsLKx1ZbncRL3InWb",
                obj_type: "docx",
                title: "About Me",
                space_id: "7385347710194008067",
                obj_edit_time: "1",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        return new Response(
          JSON.stringify({ code: 131006, msg: "permission denied: wiki space permission denied" }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const base = ctx("7385347710194008067");
    base.connection.config.wiki_node_token = "https://rescheni.feishu.cn/wiki/MICpwZMBUiIOtrkjmbJcyiHWnbf";
    await expect(adapter.listChanges(base)).rejects.toThrow(/扫码|知识库|无权/);
  });
});

describe("feishu user oauth token", () => {
  function userCtx(): AdapterContext {
    const base = ctx("");
    base.secrets = { app_id: "cli_x", app_secret: "secret-app", access_token: "u-user", refresh_token: "rt-1" };
    return base;
  }

  it("listChanges uses user token, lists wiki spaces + drive without wiki_space_id", async () => {
    const auths: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        throw new Error("should not fetch tenant token when user token present");
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      auths.push(auth);
      expect(auth).toBe("Bearer u-user");
      if (url.includes("/wiki/v2/spaces/get_node")) {
        throw new Error(`unexpected get_node ${url}`);
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  node_token: "n-user",
                  obj_token: "doxcnUSER",
                  obj_type: "docx",
                  title: "User Wiki Doc",
                  has_child: false,
                  obj_edit_time: "3",
                },
              ],
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/wiki/v2/spaces")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { items: [{ space_id: "9876543210", name: "我的知识库" }], has_more: false },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/drive/explorer/v2/root_folder/meta")) {
        return new Response(JSON.stringify({ code: 0, data: { token: "fld-root" } }), { status: 200 });
      }
      if (url.includes("/drive/v1/files")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              files: [
                {
                  token: "doxcnDRIVE",
                  name: "Drive Doc",
                  type: "docx",
                  modified_time: "9",
                },
              ],
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const { changes } = await adapter.listChanges(userCtx());
    const ids = changes.map((c) => c.source_id).sort();
    expect(ids).toEqual(["doxcnDRIVE", "doxcnUSER"].sort());
    expect(changes.some((c) => c.path?.includes("User Wiki Doc"))).toBe(true);
    expect(changes.some((c) => c.path?.includes("Drive Doc"))).toBe(true);
    expect(auths.every((a) => a === "Bearer u-user")).toBe(true);
    expect(JSON.stringify(changes)).not.toContain("secret-app");
    expect(JSON.stringify(changes)).not.toContain("u-user");
  });

  it("tenant-only listChanges still works without user token", async () => {
    const adapter = new FeishuAdapter(mockFetch());
    const { changes } = await adapter.listChanges(ctx());
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.source_id).sort()).toEqual(["doxcnAAA", "doxcnCCC"].sort());
  });

  it("refreshes user token on 401 and persists secrets", async () => {
    let spaces = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.includes("/authen/v2/oauth/token")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { grant_type?: string; refresh_token?: string };
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("rt-1");
        return new Response(
          JSON.stringify({ code: 0, access_token: "u-rotated", refresh_token: "rt-2" }),
          { status: 200 },
        );
      }
      if (url.includes("tenant_access_token/internal")) {
        throw new Error("should not fetch tenant");
      }
      if (url.includes("/wiki/v2/spaces") && !url.includes("/nodes")) {
        spaces += 1;
        if (auth === "Bearer u-stale") return new Response("unauthorized", { status: 401 });
        if (auth === "Bearer u-rotated") {
          return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), { status: 200 });
        }
      }
      throw new Error(`unexpected ${url} ${auth}`);
    };
    const persisted: Record<string, string>[] = [];
    const adapter = new FeishuAdapter(fetchFn);
    const c = userCtx();
    c.secrets = { app_id: "cli_x", app_secret: "secret-app", access_token: "u-stale", refresh_token: "rt-1" };
    c.persistSecrets = async (s) => {
      persisted.push({ ...(s as Record<string, string>) });
    };
    const ok = await adapter.probe(c);
    expect(ok.ok).toBe(true);
    expect(spaces).toBe(2);
    expect(c.secrets?.access_token).toBe("u-rotated");
    expect(c.secrets?.user_access_token).toBe("u-rotated");
    expect(persisted[0]?.access_token).toBe("u-rotated");
    expect(JSON.stringify(ok)).not.toContain("u-stale");
    expect(JSON.stringify(ok)).not.toContain("secret-app");
    expect(JSON.stringify(ok)).not.toContain("rt-1");
  });
});

describe("feishu wiki permission and node URL", () => {
  it("parseWikiNodeToken via listChanges get_node URL and surfaces 131006", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/wiki/v2/spaces/get_node")) {
        const u = new URL(url);
        expect(u.searchParams.get("token")).toBe("MICpwZMBUiIOtrkjmbJcyiHWnbf");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              node: {
                node_token: "MICpwZMBUiIOtrkjmbJcyiHWnbf",
                obj_token: "doxAbout",
                obj_type: "docx",
                title: "About Me",
                space_id: "7385347710194008067",
                has_child: false,
                obj_edit_time: "1",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        expect(url).not.toContain("parent_node_token=");
        return new Response(
          JSON.stringify({ code: 131006, msg: "permission denied: wiki space permission denied" }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected ${url}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const context: AdapterContext = {
      connection: {
        id: "c1",
        space_id: "s1",
        source: "feishu",
        name: "f",
        config: {
          wiki_space_id: "7385347710194008067",
          wiki_node_token: "https://rescheni.feishu.cn/wiki/MICpwZMBUiIOtrkjmbJcyiHWnbf",
          obj_types: ["docx"],
        },
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
    await expect(adapter.listChanges(context)).rejects.toThrow(/扫码|知识库|无权/);
    expect(calls.some((u) => u.includes("get_node"))).toBe(true);
  });

  it("omits empty parent_node_token on root walk", async () => {
    const parents: (string | null)[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/nodes")) {
        const u = new URL(url);
        parents.push(u.searchParams.get("parent_node_token"));
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  node_token: "n1",
                  obj_token: "dox1",
                  obj_type: "docx",
                  title: "Root Doc",
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
      throw new Error(url);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const { changes } = await adapter.listChanges(ctx());
    expect(changes).toHaveLength(1);
    expect(parents[0]).toBeNull();
  });
});

describe("feishu non-numeric wiki_space_id", () => {
  it("does not use non-numeric wiki_space_id as /spaces/{id}/nodes path; resolves via get_node", async () => {
    const nodeCalls: string[] = [];
    const spaceNodeCalls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/wiki/v2/spaces/get_node")) {
        nodeCalls.push(url);
        const u = new URL(url);
        expect(u.searchParams.get("token")).toBe("A7CwwMeBSi8iGpktKEkc9VR6n3e");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              node: {
                node_token: "A7CwwMeBSi8iGpktKEkc9VR6n3e",
                obj_token: "doxcnROOT",
                obj_type: "docx",
                title: "Wiki Root",
                space_id: "7385347710194008067",
                has_child: true,
                obj_edit_time: "1",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        spaceNodeCalls.push(url);
        expect(url).toContain("/spaces/7385347710194008067/nodes");
        expect(url).not.toContain("/spaces/A7CwwMeBSi8iGpktKEkc9VR6n3e/");
        const u = new URL(url);
        const parent = u.searchParams.get("parent_node_token") ?? "";
        if (parent === "A7CwwMeBSi8iGpktKEkc9VR6n3e") {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                items: [
                  {
                    node_token: "n-child",
                    obj_token: "doxcnCHILD",
                    obj_type: "docx",
                    title: "Child Doc",
                    has_child: false,
                    obj_edit_time: "2",
                  },
                ],
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const adapter = new FeishuAdapter(fetchFn);
    // Misconfigured: node token pasted into wiki_space_id; URL also in wiki_node_token
    const context: AdapterContext = {
      connection: {
        id: "c1",
        space_id: "s1",
        source: "feishu",
        name: "f",
        config: {
          wiki_space_id: "A7CwwMeBSi8iGpktKEkc9VR6n3e",
          wiki_node_token: "https://rescheni.feishu.cn/wiki/A7CwwMeBSi8iGpktKEkc9VR6n3e",
          obj_types: ["docx"],
        },
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
    const { changes } = await adapter.listChanges(context);
    expect(nodeCalls.length).toBeGreaterThanOrEqual(1);
    expect(spaceNodeCalls.every((u) => u.includes("/spaces/7385347710194008067/nodes"))).toBe(true);
    expect(spaceNodeCalls.some((u) => u.includes("A7CwwMeBSi8iGpktKEkc9VR6n3e/nodes"))).toBe(false);
    expect(changes.map((c) => c.source_id).sort()).toEqual(["doxcnCHILD", "doxcnROOT"].sort());
  });

  it("treats URL-only wiki_space_id as node token and resolves via get_node", async () => {
    const spaceNodeCalls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
      }
      if (url.includes("/wiki/v2/spaces/get_node")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              node: {
                node_token: "A7CwwMeBSi8iGpktKEkc9VR6n3e",
                obj_token: "doxcnONLY",
                obj_type: "docx",
                title: "Only",
                space_id: "111222333444",
                has_child: false,
                obj_edit_time: "5",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/wiki/v2/spaces/") && url.includes("/nodes")) {
        spaceNodeCalls.push(url);
        expect(url).toContain("/spaces/111222333444/nodes");
        return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const adapter = new FeishuAdapter(fetchFn);
    const c = ctx("https://rescheni.feishu.cn/wiki/A7CwwMeBSi8iGpktKEkc9VR6n3e");
    delete c.connection.config.wiki_node_token;
    const { changes } = await adapter.listChanges(c);
    expect(changes.some((ch) => ch.source_id === "doxcnONLY")).toBe(true);
    expect(spaceNodeCalls.some((u) => /\/spaces\/A7Cww/.test(u))).toBe(false);
  });
});
