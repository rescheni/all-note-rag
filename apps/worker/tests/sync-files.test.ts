import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../src/env.ts";
import { pool, query } from "../src/db.ts";
import { runSyncFiles } from "../src/sync.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const bucket = "obsidian-src-filesync";
const prefix = `vault-${suffix}`;

const s3 = new S3Client({
  region: env.s3Region || "us-east-1",
  endpoint: env.s3Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
});

describe("runSyncFiles", () => {
  let userId = "";
  let spaceId = "";
  let connId = "";

  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    try {
      await s3.send(new HeadBucketCommand({ Bucket: env.s3Bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: env.s3Bucket }));
    }
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/Daily/x.md`,
        Body: "# Daily\n\nfile-level-only-token PINEAPPLE_LANTERN_FILESYNC\n",
        ContentType: "text/markdown; charset=utf-8",
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/Welcome.md`,
        Body: "# Welcome\n\nshould-not-be-ingested-in-file-sync\n",
        ContentType: "text/markdown; charset=utf-8",
      }),
    );
    const u = await query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
      [`filesync-w-${suffix}@example.test`],
    );
    userId = u.rows[0].id;
    const sp = await query<{ id: string }>(
      "INSERT INTO spaces (kind, name, owner_user_id) VALUES ('personal', 'fs', $1) RETURNING id",
      [userId],
    );
    spaceId = sp.rows[0].id;
    await query(
      "INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')",
      [spaceId, userId],
    );
    const c = await query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'fs', $2::jsonb, 'active') RETURNING id`,
      [
        spaceId,
        JSON.stringify({
          bucket,
          remote_prefix: prefix,
          endpoint: env.s3Endpoint,
          region: env.s3Region || "us-east-1",
          force_path_style: true,
          e2ee: false,
        }),
      ],
    );
    connId = c.rows[0].id;
  });

  afterAll(async () => {
    try {
      if (spaceId) await query("DELETE FROM spaces WHERE id = $1", [spaceId]);
      if (userId) await query("DELETE FROM users WHERE id = $1", [userId]);
    } finally {
      await pool.end();
    }
  });

  it("processes one obsidian path without needing other files", async () => {
    await runSyncFiles(connId, [`${prefix}/Daily/x.md`]);
    const notes = await query<{ path: string; title: string }>(
      "SELECT path, title FROM notes WHERE connection_id = $1 AND deleted_at IS NULL ORDER BY path",
      [connId],
    );
    expect(notes.rows.map((n) => n.path)).toEqual(["Daily/x.md"]);
    expect(notes.rows.some((n) => n.path === "Welcome.md")).toBe(false);
    const chunks = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM chunks ch
       INNER JOIN notes n ON n.id = ch.note_id
       WHERE n.connection_id = $1`,
      [connId],
    );
    expect(Number(chunks.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});
