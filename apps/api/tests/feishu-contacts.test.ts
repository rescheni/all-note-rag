import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { app } from "../src/app.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const emailA = `fs-a-${suffix}@example.test`;
const emailB = `fs-b-${suffix}@example.test`;
const emailEditor = `fs-e-${suffix}@example.test`;
const password = "secret1";
const APP_ID = `cli-${suffix}`;
const APP_SECRET = `fs-secret-${suffix}`;

async function parse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, raw: text };
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function post(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, token?: string) {
  return parse(await app.request(path, { headers: headers(token) }));
}

function mockFeishuDirectory(users: Record<string, unknown>[]) {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { app_id?: string; app_secret?: string };
      expect(body.app_id).toBe(APP_ID);
      expect(body.app_secret).toBe(APP_SECRET);
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-test" }), { status: 200 });
    }
    if (url.includes("/contact/v3/departments/0/children")) {
      return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), { status: 200 });
    }
    if (url.includes("/contact/v3/scopes")) {
      return new Response(JSON.stringify({ code: 0, data: { department_ids: [], has_more: false } }), { status: 200 });
    }
    if (url.includes("/contact/v3/users/find_by_department")) {
      return new Response(JSON.stringify({ code: 0, data: { items: users, has_more: false } }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return fetchFn;
}

describe("feishu contacts sync", () => {
  let tokenA = "";
  let tokenB = "";
  let userA = "";
  let userB = "";
  let userE = "";
  let personalA = "";
  let teamId = "";
  let connId = "";
  let personalConn = "";
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email: emailA, password, display_name: "甲" });
    expect(a.status).toBe(201);
    tokenA = a.body.token;
    userA = a.body.user.id;
    personalA = a.body.space.id;

    const b = await post("/v1/auth/register", { email: emailB, password, display_name: "乙" });
    expect(b.status).toBe(201);
    tokenB = b.body.token;
    userB = b.body.user.id;

    const e = await post("/v1/auth/register", { email: emailEditor, password, display_name: "编" });
    expect(e.status).toBe(201);
    userE = e.body.user.id;

    const team = await post("/v1/spaces", { name: "飞书通讯录团", kind: "team" }, tokenA);
    expect(team.status).toBe(201);
    teamId = team.body.space.id;

    const addedEditor = await post(
      `/v1/spaces/${teamId}/members`,
      { email: emailEditor, role: "editor" },
      tokenA,
    );
    expect(addedEditor.status).toBe(201);

    const created = await post(
      `/v1/spaces/${teamId}/connections`,
      {
        source: "feishu",
        name: "飞书知识库",
        config: { wiki_space_id: "spc_test" },
        secrets: { app_id: APP_ID, app_secret: APP_SECRET },
      },
      tokenA,
    );
    expect(created.status).toBe(201);
    connId = created.body.connection.id;
    expect(JSON.stringify(created.body)).not.toContain(APP_SECRET);

    const pconn = await post(
      `/v1/spaces/${personalA}/connections`,
      {
        source: "feishu",
        name: "个人飞书",
        config: { wiki_space_id: "spc_p" },
        secrets: { app_id: APP_ID, app_secret: APP_SECRET },
      },
      tokenA,
    );
    expect(pconn.status).toBe(201);
    personalConn = pconn.body.connection.id;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    const ids = [userA, userB, userE].filter(Boolean);
    try {
      if (ids.length) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
      }
    } finally {
      await redis.quit();
      await pool.end();
    }
  });

  it("matches email to hub user as viewer; skips unknown; keeps owner/editor; second sync is idempotent", async () => {
    const directory = [
      { open_id: "ou_a", email: emailA, name: "甲" },
      { open_id: "ou_b", email: emailB.toUpperCase(), name: "乙" },
      { open_id: "ou_e", email: emailEditor, name: "编" },
      { open_id: "ou_ghost", email: `ghost-${suffix}@nowhere.test`, name: "鬼" },
      { open_id: "ou_none", name: "无邮箱" },
    ];
    globalThis.fetch = mockFeishuDirectory(directory);

    const first = await post(`/v1/connections/${connId}/contacts/sync`, {}, tokenA);
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).not.toContain(APP_SECRET);
    expect(first.body.contacts_sync.matched).toBe(3);
    expect(first.body.contacts_sync.added).toBe(1);
    expect(first.body.contacts_sync.already_member).toBe(2);
    expect(first.body.contacts_sync.skipped).toBe(2);
    expect(first.body.contacts_sync.pulled).toBe(5);

    const members = await get(`/v1/spaces/${teamId}/members`, tokenA);
    expect(members.status).toBe(200);
    const byId = Object.fromEntries(
      (members.body.members as { user_id: string; role: string }[]).map((m) => [m.user_id, m.role]),
    );
    expect(byId[userA]).toBe("owner");
    expect(byId[userE]).toBe("editor");
    expect(byId[userB]).toBe("viewer");
    expect(members.body.members).toHaveLength(3);

    const second = await post(`/v1/connections/${connId}/contacts/sync`, {}, tokenA);
    expect(second.status).toBe(200);
    expect(second.body.contacts_sync.added).toBe(0);
    expect(second.body.contacts_sync.already_member).toBe(3);
    const again = await get(`/v1/spaces/${teamId}/members`, tokenA);
    expect(again.body.members).toHaveLength(3);
    const byId2 = Object.fromEntries(
      (again.body.members as { user_id: string; role: string }[]).map((m) => [m.user_id, m.role]),
    );
    expect(byId2[userA]).toBe("owner");
    expect(byId2[userE]).toBe("editor");

    const stored = await get(`/v1/connections/${connId}/contacts`, tokenA);
    expect(stored.status).toBe(200);
    expect(stored.body.contacts_sync.added).toBe(0);
    expect(JSON.stringify(stored.body)).not.toContain(APP_SECRET);
  });

  it("does not add extra members on a personal space", async () => {
    globalThis.fetch = mockFeishuDirectory([
      { open_id: "ou_a", email: emailA, name: "甲" },
      { open_id: "ou_b", email: emailB, name: "乙" },
    ]);
    const r = await post(`/v1/connections/${personalConn}/contacts/sync`, {}, tokenA);
    expect(r.status).toBe(200);
    expect(r.body.contacts_sync.added).toBe(0);
    const members = await get(`/v1/spaces/${personalA}/members`, tokenA);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].user_id).toBe(userA);
    expect(members.body.members[0].role).toBe("owner");
  });

  it("viewer cannot trigger contacts sync", async () => {
    const gate = await post(`/v1/connections/${connId}/contacts/sync`, {}, tokenB);
    expect(gate.status).toBe(403);
  });
});
