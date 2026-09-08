import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { app } from "../src/app.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `hubui-${suffix}@example.test`;
const password = "secret1";
const SECRET_KEY = "sk-test-never-echo-xyz";

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

async function patch(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

describe("tree / activity / settings", () => {
  let token = "";
  let userId = "";
  let spaceId = "";
  let syConn = "";
  let obConn = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "中枢" });
    expect(a.status).toBe(201);
    token = a.body.token;
    userId = a.body.user.id;
    spaceId = a.body.space.id;

    const sy = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status, cursor)
       VALUES ($1, 'siyuan', '我的思源', '{"e2ee":false}'::jsonb, 'active', $2::jsonb)
       RETURNING id`,
      [spaceId, JSON.stringify({ boxNames: { "20241211071716-w11cbza": "生活" } })],
    );
    syConn = sy.rows[0].id;
    const ob = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'Obsidian', '{"e2ee":false}'::jsonb, 'active') RETURNING id`,
      [spaceId],
    );
    obConn = ob.rows[0].id;
    await pool.query(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'feishu', '飞书', '{"e2ee":false}'::jsonb, 'active')`,
      [spaceId],
    );

    await pool.query(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash, updated_at)
       VALUES
         ($1, $2, 'parent', '20241211071716-w11cbza/20241211214233-uokc9hs.sy', '父文档', 'p', 'h1', '2026-03-12 04:00:00+00'),
         ($1, $2, 'child', '20241211071716-w11cbza/20241211214233-uokc9hs.sy/20241212000000-child.sy', '子文档', 'c', 'h2', '2026-03-12 04:00:00+00'),
         ($1, $3, 'daily', 'Daily/2026-08-29.md', '日记', 'd', 'h3', '2026-03-12 16:30:00+00')`,
      [spaceId, syConn, obConn],
    );
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM hub_settings WHERE id = 'ai'");
      if (userId) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      }
    } finally {
      await redis.quit();
      await pool.end();
    }
  });

  it("GET /tree groups by source, uses titles, nests parent.sy/child.sy, maps box names", async () => {
    const r = await get(`/v1/spaces/${spaceId}/tree`, token);
    expect(r.status).toBe(200);
    const groups = r.body.groups as {
      source: string;
      connection_id: string;
      name: string;
      tree: {
        name: string;
        path: string;
        kind: string;
        has_children?: boolean;
        children?: { name: string; kind: string; note_id?: string; children?: { name: string; kind: string }[] }[];
      }[];
    }[];
    expect(groups.map((g) => g.source)).toEqual(["feishu", "siyuan", "obsidian"]);
    const fs = groups.find((g) => g.source === "feishu");
    expect(fs?.tree).toEqual([]);
    const sy = groups.find((g) => g.source === "siyuan");
    expect(sy?.name).toBe("我的思源");
    expect(sy?.tree[0]?.name).toBe("生活");
    expect(sy?.tree[0]?.path).toContain("20241211071716-w11cbza");
    expect(sy?.tree[0]?.has_children).toBe(true);
    expect(sy?.tree[0]?.children).toBeUndefined();
    const expanded = await get(
      `/v1/spaces/${spaceId}/tree?connection_id=${sy?.connection_id}&parent=${encodeURIComponent(sy?.tree[0]?.path ?? "")}`,
      token,
    );
    expect(expanded.status).toBe(200);
    const kids = expanded.body.tree as {
      name: string;
      kind: string;
      has_children?: boolean;
      children?: { name: string; kind: string }[];
    }[];
    const parent = kids[0];
    expect(parent?.name).toBe("父文档");
    expect(parent?.kind).toBe("note");
    expect(parent?.has_children).toBe(true);
    const nested = await get(
      `/v1/spaces/${spaceId}/tree?connection_id=${sy?.connection_id}&parent=${encodeURIComponent("20241211071716-w11cbza/20241211214233-uokc9hs.sy")}`,
      token,
    );
    expect(nested.body.tree.some((c: { name: string; kind: string }) => c.name === "子文档" && c.kind === "note")).toBe(true);
    const ob = groups.find((g) => g.source === "obsidian");
    expect(ob?.tree[0]?.name).toBe("Daily");
    expect(ob?.tree[0]?.has_children).toBe(true);
    const roots = r.body.tree as { name: string }[];
    expect(roots.map((n) => n.name)).toEqual(["飞书", "思源", "Obsidian"]);
  });

  it("GET /activity uses source_updated_at instead of ingest time", async () => {
    await pool.query(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash, source_updated_at, updated_at)
       VALUES ($1, $2, 'src-date', '20241211071716-w11cbza/20250414073505-src.sy', '源日期', 's', 'h-src',
               '2026-01-20 07:35:05+08', '2026-09-01 05:00:00+00')`,
      [spaceId, syConn],
    );
    const r = await get(`/v1/spaces/${spaceId}/activity?days=365`, token);
    expect(r.status).toBe(200);
    const days = r.body.days as { date: string; notes: number }[];
    expect(days.find((d) => d.date === "2026-01-20")?.notes).toBeGreaterThanOrEqual(1);
    // ingest time would be 2026-09-01 13:00 Shanghai; source date must win
    expect(days.find((d) => d.date === "2026-09-01")?.notes ?? 0).toBe(0);
  });

  it("GET /activity aggregates notes by Asia/Shanghai date", async () => {
    const r = await get(`/v1/spaces/${spaceId}/activity?days=365`, token);
    expect(r.status).toBe(200);
    const days = r.body.days as { date: string; notes: number; upserts?: number }[];
    expect(days.length).toBe(365);
    const d12 = days.find((d) => d.date === "2026-03-12");
    // 04:00 UTC = 12:00 Shanghai same day (2 sy notes); 16:30 UTC = 03-13 00:30 Shanghai
    expect(d12?.notes).toBeGreaterThanOrEqual(2);
    const d13 = days.find((d) => d.date === "2026-03-13");
    expect(d13?.notes).toBeGreaterThanOrEqual(1);
    expect(days.at(-1)?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("PATCH/GET settings never returns the api key", async () => {
    const saved = await patch(
      "/v1/settings/ai",
      {
        base_url: "https://api.openai.com/v1",
        api_key: SECRET_KEY,
        embedding_model: "text-embedding-3-small",
        chat_model: "gpt-4o-mini",
        embed_provider: "api",
      },
      token,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.embed_provider).toBe("api");
    expect(saved.body.base_url).toBe("https://api.openai.com/v1");
    expect(saved.raw).not.toContain(SECRET_KEY);
    expect(saved.body.api_key).toBeUndefined();
    expect(JSON.stringify(saved.body).toLowerCase()).not.toContain("sk-test");

    const got = await get("/v1/settings/ai", token);
    expect(got.status).toBe(200);
    expect(got.body.configured).toBe(true);
    expect(got.body.base_url).toBe("https://api.openai.com/v1");
    expect(got.body.embedding_model).toBe("text-embedding-3-small");
    expect(got.body.chat_model).toBe("gpt-4o-mini");
    expect(got.body.embed_provider).toBe("api");
    expect(got.body.api_key).toBeUndefined();
    expect(got.raw).not.toContain(SECRET_KEY);
    expect(JSON.stringify(got.body)).not.toMatch(/api_key|sk-/i);
  });

  it("lists and can select local embed provider", async () => {
    const listed = await get("/v1/settings/ai/local-embed-models", token);
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.models)).toBe(true);
    expect(listed.body.models.length).toBeGreaterThan(0);
    expect(listed.body.model_dir).toBeTruthy();

    const saved = await patch(
      "/v1/settings/ai",
      {
        embed_provider: "local",
        embedding_model: "Xenova/bge-small-zh-v1.5",
      },
      token,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.embed_provider).toBe("local");
    expect(saved.body.embedding_model).toBe("Xenova/bge-small-zh-v1.5");
    expect(saved.body.api_key).toBeUndefined();
  });

});
