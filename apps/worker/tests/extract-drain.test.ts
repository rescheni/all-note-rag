import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { query } from "../src/db.ts";
import { drainExtractBatch } from "../src/extract-drain.ts";
import { needsExtract } from "../src/extract-asset.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

describe("extract drain", () => {
  let userId = "";
  let spaceId = "";
  let connId = "";
  let noteId = "";
  let pendingId = "";
  let okId = "";
  let bodyChunkId = "";

  beforeAll(async () => {
    const u = await query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
      [`extract-drain-${suffix}@example.test`],
    );
    userId = u.rows[0].id;
    const sp = await query<{ id: string }>(
      "INSERT INTO spaces (kind, name, owner_user_id) VALUES ('personal', 'ed', $1) RETURNING id",
      [userId],
    );
    spaceId = sp.rows[0].id;
    await query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')", [spaceId, userId]);
    const c = await query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'ed', '{}'::jsonb, 'active') RETURNING id`,
      [spaceId],
    );
    connId = c.rows[0].id;
    const n = await query<{ id: string }>(
      `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, hash)
       VALUES ($1, $2, 'src-ed', 'Drain.md', 'Drain note', '# Drain\\n\\nbody keep me', 'hash-ed')
       RETURNING id`,
      [spaceId, connId],
    );
    noteId = n.rows[0].id;
    const body = await query<{ id: string }>(
      `INSERT INTO blocks (note_id, source_block_id, type, text, order_key, depth)
       VALUES ($1, 'p1', 'paragraph', 'body keep me', '0001', 0) RETURNING id`,
      [noteId],
    );
    const ch = await query<{ id: string }>(
      `INSERT INTO chunks (note_id, space_id, block_id, heading_path, text, token_count, fts)
       VALUES ($1, $2, $3, '', 'body keep me', 3, to_tsvector('simple', 'body keep me'))
       RETURNING id`,
      [noteId, spaceId, body.rows[0].id],
    );
    bodyChunkId = ch.rows[0].id;

    const pending = await query<{ id: string }>(
      `INSERT INTO assets (note_id, space_id, source_path, content_type, s3_key, hash, bytes, extracted_text, extract_status)
       VALUES ($1, $2, 'assets/invoice.png', 'image/png', 'canonical/test/invoice.png', 'hash-pending', 12, '图片 invoice.png', 'pending')
       RETURNING id`,
      [noteId, spaceId],
    );
    pendingId = pending.rows[0].id;
    const ok = await query<{ id: string }>(
      `INSERT INTO assets (note_id, space_id, source_path, content_type, s3_key, hash, bytes, extracted_text, extract_status)
       VALUES ($1, $2, 'assets/done.png', 'image/png', 'canonical/test/done.png', 'hash-ok', 12, 'already ocr text', 'ok')
       RETURNING id`,
      [noteId, spaceId],
    );
    okId = ok.rows[0].id;
  });

  afterAll(async () => {
    try {
      if (spaceId) await query("DELETE FROM spaces WHERE id = $1", [spaceId]);
      if (userId) await query("DELETE FROM users WHERE id = $1", [userId]);
    } catch {
      /* ignore */
    }
  });

  it("pending + placeholder still needs extract; hash-match ok skips", () => {
    expect(
      needsExtract({ hash: "hash-pending", extracted_text: "图片 invoice.png", extract_status: "pending" }, "hash-pending"),
    ).toBe(true);
    expect(
      needsExtract({ hash: "hash-ok", extracted_text: "already ocr text", extract_status: "ok" }, "hash-ok"),
    ).toBe(false);
  });

  it("drain updates pending to ok, writes chunk text, skips already-ok", async () => {
    const calls: string[] = [];
    const result = await drainExtractBatch({
      noteId,
      limit: 8,
      concurrency: 1,
      getBytes: async (key) => {
        calls.push(`bytes:${key}`);
        return new Uint8Array([1, 2, 3, 4]);
      },
      extract: async ({ filename }) => {
        calls.push(`ocr:${filename}`);
        return { text: "发票金额 998877", status: "ok" };
      },
    });

    expect(result.ok).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.startsWith("ocr:invoice.png"))).toBe(true);
    expect(calls.some((c) => c.includes("done.png"))).toBe(false);

    const pendingRow = await query<{ extract_status: string; extracted_text: string }>(
      "SELECT extract_status, extracted_text FROM assets WHERE id = $1",
      [pendingId],
    );
    expect(pendingRow.rows[0].extract_status).toBe("ok");
    expect(pendingRow.rows[0].extracted_text).toContain("发票金额 998877");
    expect(pendingRow.rows[0].extracted_text).not.toMatch(/^图片 /);

    const okRow = await query<{ extract_status: string; extracted_text: string }>(
      "SELECT extract_status, extracted_text FROM assets WHERE id = $1",
      [okId],
    );
    expect(okRow.rows[0].extract_status).toBe("ok");
    expect(okRow.rows[0].extracted_text).toBe("already ocr text");

    const chunks = await query<{ text: string; heading_path: string | null }>(
      "SELECT text, heading_path FROM chunks WHERE note_id = $1",
      [noteId],
    );
    expect(chunks.rows.some((r) => r.text.includes("发票金额 998877"))).toBe(true);
    expect(chunks.rows.some((r) => r.text === "body keep me")).toBe(true);
    const bodyStill = await query<{ id: string }>("SELECT id FROM chunks WHERE id = $1", [bodyChunkId]);
    expect(bodyStill.rows[0]?.id).toBe(bodyChunkId);
  });
});
