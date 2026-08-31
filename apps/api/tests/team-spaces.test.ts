import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { app } from "../src/app.ts";
import { checkRole } from "../src/auth.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const emailA = `team-a-${suffix}@example.test`;
const emailB = `team-b-${suffix}@example.test`;
const password = "secret1";

async function parse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
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

async function put(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

async function del(path: string, token?: string) {
  return parse(await app.request(path, { method: "DELETE", headers: headers(token) }));
}

describe("checkRole with fake membership", () => {
  it("viewer cannot manage connections or skills", () => {
    const viewer = { space_id: "space-1", role: "viewer" as const };
    expect(checkRole(null, "viewer")).toBe("not_found");
    expect(checkRole(viewer, "viewer")).toBe("ok");
    expect(checkRole(viewer, "editor")).toBe("forbidden");
    expect(checkRole(viewer, "owner")).toBe("forbidden");
    expect(checkRole({ space_id: "space-1", role: "editor" }, "editor")).toBe("ok");
    expect(checkRole({ space_id: "space-1", role: "editor" }, "owner")).toBe("forbidden");
    expect(checkRole({ space_id: "space-1", role: "owner" }, "owner")).toBe("ok");
  });
});

describe("team spaces", () => {
  let tokenA = "";
  let tokenB = "";
  let userA = "";
  let userB = "";
  let personalA = "";
  let teamId = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", {
      email: emailA,
      password,
      display_name: "甲",
    });
    expect(a.status).toBe(201);
    tokenA = a.body.token;
    userA = a.body.user.id;
    personalA = a.body.space.id;

    const b = await post("/v1/auth/register", {
      email: emailB,
      password,
      display_name: "乙",
    });
    expect(b.status).toBe(201);
    tokenB = b.body.token;
    userB = b.body.user.id;
  });

  afterAll(async () => {
    const ids = [userA, userB].filter(Boolean);
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

  it("creates a team space and rejects kind=personal", async () => {
    const personal = await post("/v1/spaces", { name: "不该存在", kind: "personal" }, tokenA);
    expect(personal.status).toBe(400);
    expect(personal.body.error?.code).toBe("invalid_request");

    const unnamed = await post("/v1/spaces", { kind: "team" }, tokenA);
    expect(unnamed.status).toBe(400);

    const created = await post("/v1/spaces", { name: "研发文档", kind: "team" }, tokenA);
    expect(created.status).toBe(201);
    expect(created.body.space.kind).toBe("team");
    expect(created.body.space.name).toBe("研发文档");
    expect(created.body.role).toBe("owner");
    teamId = created.body.space.id;

    const listed = await get("/v1/spaces", tokenA);
    expect(listed.status).toBe(200);
    const kinds = listed.body.spaces.map((s: { kind: string }) => s.kind).sort();
    expect(kinds).toEqual(["personal", "team"]);
  });

  it("adds a member by email and rejects a second personal member", async () => {
    const added = await post(
      `/v1/spaces/${teamId}/members`,
      { email: emailB, role: "viewer" },
      tokenA,
    );
    expect(added.status).toBe(201);
    expect(added.body.member.user_id).toBe(userB);
    expect(added.body.member.role).toBe("viewer");
    expect(added.body.member.email).toBe(emailB);

    const again = await post(
      `/v1/spaces/${teamId}/members`,
      { email: emailB, role: "editor" },
      tokenA,
    );
    expect(again.status).toBe(409);

    const personalAdd = await post(
      `/v1/spaces/${personalA}/members`,
      { email: emailB, role: "viewer" },
      tokenA,
    );
    expect(personalAdd.status).toBe(400);

    const personalPut = await put(
      `/v1/spaces/${personalA}/members/${userB}`,
      { role: "viewer" },
      tokenA,
    );
    expect(personalPut.status).toBe(400);

    const members = await get(`/v1/spaces/${personalA}/members`, tokenA);
    expect(members.body.members).toHaveLength(1);
  });

  it("viewer cannot POST sync or install skill", async () => {
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'vault', '{"bucket":"x"}'::jsonb, 'paused')
       RETURNING id`,
      [teamId],
    );
    const connId = conn.rows[0].id;

    const sync = await post(`/v1/connections/${connId}/sync`, {}, tokenB);
    expect(sync.status).toBe(403);
    expect(sync.body.error?.code).toBe("forbidden");

    const install = await post(
      `/v1/spaces/${teamId}/skills/install`,
      { skill_id: "growth-weekly" },
      tokenB,
    );
    expect(install.status).toBe(403);
    expect(install.body.error?.code).toBe("forbidden");

    const enable = await post(
      `/v1/spaces/${teamId}/skills/growth-weekly/enable`,
      { enabled: true },
      tokenB,
    );
    expect(enable.status).toBe(403);
  });

  it("growth on team still 400", async () => {
    const list = await get(`/v1/spaces/${teamId}/growth`, tokenA);
    expect(list.status).toBe(400);
    expect(list.body.error?.code).toBe("growth_personal_only");

    const write = await post(
      `/v1/spaces/${teamId}/growth`,
      { kind: "goal", happened_at: "2026-08-31T00:00:00.000Z", payload: { title: "x" } },
      tokenA,
    );
    expect(write.status).toBe(400);
    expect(write.body.error?.code).toBe("growth_personal_only");

    const report = await get(`/v1/spaces/${teamId}/growth/report`, tokenA);
    expect(report.status).toBe(400);
    expect(report.body.error?.code).toBe("growth_personal_only");
  });

  it("ask/search/notes 404 for non-members and last owner is protected", async () => {
    const notes = await get(`/v1/spaces/${personalA}/notes`, tokenB);
    expect(notes.status).toBe(404);
    const search = await get(`/v1/spaces/${personalA}/search?q=hi`, tokenB);
    expect(search.status).toBe(404);
    const ask = await post(`/v1/spaces/${personalA}/ask`, { query: "hi" }, tokenB);
    expect(ask.status).toBe(404);

    const demote = await put(
      `/v1/spaces/${teamId}/members/${userA}`,
      { role: "editor" },
      tokenA,
    );
    expect(demote.status).toBe(400);

    const remove = await del(`/v1/spaces/${teamId}/members/${userA}`, tokenA);
    expect(remove.status).toBe(400);
  });
});
