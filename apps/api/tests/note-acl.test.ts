import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { toFtsTokens } from "@note-hub/core";
import { app } from "../src/app.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const emailA = `acl-a-${suffix}@example.test`;
const emailB = `acl-b-${suffix}@example.test`;
const password = "secret1";
const SECRET = `acl-secret-token-${suffix}`;

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

async function patch(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

describe("document-level note ACL", () => {
  let tokenA = "";
  let tokenB = "";
  let userA = "";
  let userB = "";
  let teamId = "";
  let connId = "";
  let openNote = "";
  let hiddenNote = "";
  let legacyNote = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email: emailA, password, display_name: "甲" });
    expect(a.status).toBe(201);
    tokenA = a.body.token;
    userA = a.body.user.id;

    const b = await post("/v1/auth/register", { email: emailB, password, display_name: "乙" });
    expect(b.status).toBe(201);
    tokenB = b.body.token;
    userB = b.body.user.id;

    const team = await post("/v1/spaces", { name: "ACL 团队", kind: "team" }, tokenA);
    expect(team.status).toBe(201);
    teamId = team.body.space.id;

    const added = await post(`/v1/spaces/${teamId}/members`, { email: emailB, role: "viewer" }, tokenA);
    expect(added.status).toBe(201);

    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'acl-vault', '{"e2ee":false}'::jsonb, 'paused')
       RETURNING id`,
      [teamId],
    );
    connId = conn.rows[0].id;

    const open = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash, acl_snapshot)
       VALUES ($1,$2,'open-1','Open.md','公开笔记',$3,'h-open',
               '{"visibility":"space","visible_in_space":true}'::jsonb)
       RETURNING id`,
      [teamId, connId, `这篇写了 ${SECRET} 公开可见。`],
    );
    openNote = open.rows[0].id;

    const hid = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash, acl_snapshot)
       VALUES ($1,$2,'hid-1','Hidden.md','仅部分人可见',$3,'h-hid',
               '{"visibility":"space","visible_in_space":true}'::jsonb)
       RETURNING id`,
      [teamId, connId, `机密句 ${SECRET} 稍后会收起来。`],
    );
    hiddenNote = hid.rows[0].id;

    const legacy = await pool.query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash, acl_snapshot)
       VALUES ($1,$2,'legacy-1','Legacy.md','旧快照',$3,'h-legacy',
               '{"visible_in_space":true}'::jsonb)
       RETURNING id`,
      [teamId, connId, `旧行 ${SECRET} 仍按空间可见。`],
    );
    legacyNote = legacy.rows[0].id;

    for (const [noteId, text] of [
      [openNote, `这篇写了 ${SECRET} 公开可见。`],
      [hiddenNote, `机密句 ${SECRET} 稍后会收起来。`],
      [legacyNote, `旧行 ${SECRET} 仍按空间可见。`],
    ] as const) {
      await pool.query(
        `INSERT INTO chunks (note_id, space_id, text, token_count, fts)
         VALUES ($1,$2,$3,12, to_tsvector('simple', $4))`,
        [noteId, teamId, text, toFtsTokens(text)],
      );
    }

    await pool.query(
      `INSERT INTO assets (note_id, space_id, source_path, content_type, s3_key, hash, bytes)
       VALUES ($1,$2,'secret.png','image/png','canonical/x/y/secret.png','h',12)`,
      [hiddenNote, teamId],
    );
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

  it("default visible_in_space still works for existing rows", async () => {
    const list = await get(`/v1/spaces/${teamId}/notes`, tokenB);
    expect(list.status).toBe(200);
    const ids = (list.body.notes as { id: string }[]).map((n) => n.id);
    expect(ids).toContain(openNote);
    expect(ids).toContain(hiddenNote);
    expect(ids).toContain(legacyNote);

    const got = await get(`/v1/notes/${legacyNote}`, tokenB);
    expect(got.status).toBe(200);
    expect(got.body.note.acl.visibility).toBe("space");
    expect(got.body.note.acl.visible_in_space).toBe(true);

    const search = await get(`/v1/spaces/${teamId}/search?q=${encodeURIComponent(SECRET)}`, tokenB);
    expect(search.status).toBe(200);
    const hits = (search.body.results as { note_id: string }[]).map((h) => h.note_id);
    expect(hits).toContain(legacyNote);
    expect(hits).toContain(hiddenNote);
  });

  it("owner can PATCH ACL; member without grant cannot GET; search/ask omit it", async () => {
    const asViewer = await patch(`/v1/notes/${hiddenNote}/acl`, { visibility: "owners" }, tokenB);
    expect(asViewer.status).toBe(403);

    const restricted = await patch(
      `/v1/notes/${hiddenNote}/acl`,
      { visibility: "members", user_ids: [userA] },
      tokenA,
    );
    expect(restricted.status).toBe(200);
    expect(restricted.body.note.acl.visibility).toBe("members");
    expect(restricted.body.note.acl.visible_in_space).toBe(false);
    expect(restricted.body.note.acl.user_ids).toContain(userA);

    const ownerGet = await get(`/v1/notes/${hiddenNote}`, tokenA);
    expect(ownerGet.status).toBe(200);
    expect(ownerGet.body.note.title).toBe("仅部分人可见");
    expect(ownerGet.body.can_patch_acl).toBe(true);

    const memberGet = await get(`/v1/notes/${hiddenNote}`, tokenB);
    expect(memberGet.status).toBe(404);

    const preview = await get(`/v1/notes/${hiddenNote}/preview?format=json`, tokenB);
    expect(preview.status).toBe(404);

    const asset = await get(`/v1/notes/${hiddenNote}/assets?path=secret.png`, tokenB);
    expect(asset.status).toBe(404);

    const list = await get(`/v1/spaces/${teamId}/notes`, tokenB);
    const listIds = (list.body.notes as { id: string }[]).map((n) => n.id);
    expect(listIds).not.toContain(hiddenNote);
    expect(listIds).toContain(openNote);
    expect(listIds).toContain(legacyNote);

    const tree = await get(`/v1/spaces/${teamId}/tree`, tokenB);
    expect(tree.status).toBe(200);
    const dump = JSON.stringify(tree.body);
    expect(dump).not.toContain(hiddenNote);
    expect(dump).toContain(openNote);
    const groups = tree.body.groups as { source: string; tree: { name: string }[] }[];
    expect(groups.some((g) => g.source === "obsidian")).toBe(true);

    const search = await get(`/v1/spaces/${teamId}/search?q=${encodeURIComponent(SECRET)}`, tokenB);
    expect(search.status).toBe(200);
    const hits = (search.body.results as { note_id: string }[]).map((h) => h.note_id);
    expect(hits).not.toContain(hiddenNote);
    expect(hits).toContain(openNote);

    const ask = await post(`/v1/spaces/${teamId}/ask`, { query: `机密句 ${SECRET}` }, tokenB);
    expect(ask.status).toBe(200);
    const cited = (ask.body.citations as { note_id: string }[] | undefined)?.map((c) => c.note_id) ?? [];
    expect(cited).not.toContain(hiddenNote);

    const ownerSearch = await get(`/v1/spaces/${teamId}/search?q=${encodeURIComponent(SECRET)}`, tokenA);
    const ownerHits = (ownerSearch.body.results as { note_id: string }[]).map((h) => h.note_id);
    expect(ownerHits).toContain(hiddenNote);

    const listed = await patch(
      `/v1/notes/${hiddenNote}/acl`,
      { visibility: "members", user_ids: [userB] },
      tokenA,
    );
    expect(listed.status).toBe(200);
    const granted = await get(`/v1/notes/${hiddenNote}`, tokenB);
    expect(granted.status).toBe(200);

    const back = await patch(`/v1/notes/${hiddenNote}/acl`, { visibility: "space" }, tokenA);
    expect(back.status).toBe(200);
    expect(back.body.note.acl.visible_in_space).toBe(true);
    const again = await get(`/v1/notes/${hiddenNote}`, tokenB);
    expect(again.status).toBe(200);
  });
});
