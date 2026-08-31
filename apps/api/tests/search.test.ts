import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { toFtsTokens } from "@note-hub/core";
import { formatVector, localProject } from "@note-hub/retrieve";
import { app } from "../src/app.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `search-${suffix}@example.test`;
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

describe("search sources + similar", () => {
  let token = "";
  let otherToken = "";
  let userId = "";
  let otherUser = "";
  let spaceId = "";
  let otherSpace = "";
  let sourceNoteId = "";
  let similarNoteId = "";
  let leakNoteId = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "搜" });
    expect(a.status).toBe(201);
    token = a.body.token;
    userId = a.body.user.id;
    spaceId = a.body.space.id;

    const b = await post("/v1/auth/register", {
      email: `search-b-${suffix}@example.test`,
      password,
      display_name: "乙",
    });
    expect(b.status).toBe(201);
    otherToken = b.body.token;
    otherUser = b.body.user.id;
    otherSpace = b.body.space.id;

    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'search-fix', '{"e2ee":false}'::jsonb, 'active') RETURNING id`,
      [spaceId],
    );
    const connId = conn.rows[0].id;
    const otherConn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'search-leak', '{"e2ee":false}'::jsonb, 'active') RETURNING id`,
      [otherSpace],
    );
    const otherConnId = otherConn.rows[0].id;

    const q = "紫铜灯笼检索词";
    const qEmb = localProject(q);

    const src = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash)
       VALUES ($1,$2,'src-1','Daily/2026-08-29.md','日记',$3,'h-src') RETURNING id`,
      [spaceId, connId, `今天看到${q}写在门上。`],
    );
    sourceNoteId = src.rows[0].id;
    const sim = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash)
       VALUES ($1,$2,'sim-1','Collections/lantern.md','提灯收藏',$3,'h-sim') RETURNING id`,
      [spaceId, connId, "牛奶鸡蛋面包购物清单，与查询无关。"],
    );
    similarNoteId = sim.rows[0].id;
    const leak = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash)
       VALUES ($1,$2,'leak-1','secret.md','秘密',$3,'h-leak') RETURNING id`,
      [otherSpace, otherConnId, `${q} 其他空间`],
    );
    leakNoteId = leak.rows[0].id;

    async function chunk(noteId: string, space: string, text: string, emb: number[]) {
      await pool.query(
        `INSERT INTO chunks (note_id, space_id, text, token_count, embedding, fts)
         VALUES ($1,$2,$3,8,$4::vector, to_tsvector('simple', $5))`,
        [noteId, space, text, formatVector(emb), toFtsTokens(text)],
      );
    }
    await chunk(sourceNoteId, spaceId, `今天看到${q}写在门上。`, qEmb);
    await chunk(similarNoteId, spaceId, "牛奶鸡蛋面包购物清单，与查询无关。", qEmb);
    await chunk(leakNoteId, otherSpace, `${q} 其他空间`, qEmb);
  });

  afterAll(async () => {
    try {
      if (userId) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      }
      if (otherUser) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = $1", [otherUser]);
        await pool.query("DELETE FROM users WHERE id = $1", [otherUser]);
      }
    } finally {
      await redis.quit();
      await pool.end();
    }
  });

  it("keyword hit in results, different embedded note in similar, no dupes or leaks", async () => {
    const r = await get(`/v1/spaces/${spaceId}/search?q=${encodeURIComponent("紫铜灯笼检索词")}`, token);
    expect(r.status).toBe(200);
    expect(r.body.query).toBe("紫铜灯笼检索词");
    const results = r.body.results as { note_id: string; path: string; match: string }[];
    const similar = r.body.similar as { note_id: string; path: string; score: number }[];
    expect(results.map((x) => x.note_id)).toContain(sourceNoteId);
    expect(results.find((x) => x.note_id === sourceNoteId)?.path).toBe("Daily/2026-08-29.md");
    expect(results.find((x) => x.note_id === sourceNoteId)?.match).toMatch(/keyword|path/);
    expect(results.map((x) => x.note_id)).not.toContain(similarNoteId);
    expect(similar.map((x) => x.note_id)).toContain(similarNoteId);
    expect(similar.find((x) => x.note_id === similarNoteId)?.path).toBe("Collections/lantern.md");
    expect(similar.find((x) => x.note_id === similarNoteId)?.score).toBeGreaterThan(0.5);
    const ids = [...results, ...similar].map((x) => x.note_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(leakNoteId);
  });

  it("GET /notes/:id/similar is member-only and stays in-space", async () => {
    const r = await get(`/v1/notes/${sourceNoteId}/similar`, token);
    expect(r.status).toBe(200);
    const similar = r.body.similar as { note_id: string }[];
    expect(similar.map((x) => x.note_id)).toContain(similarNoteId);
    expect(similar.map((x) => x.note_id)).not.toContain(sourceNoteId);
    expect(similar.map((x) => x.note_id)).not.toContain(leakNoteId);

    const denied = await get(`/v1/notes/${sourceNoteId}/similar`, otherToken);
    expect(denied.status).toBe(404);
  });
});
