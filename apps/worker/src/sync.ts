import {
  decryptSecret,
  isHubError,
  isMarkdownPath,
  toFtsTokens,
  type Adapter,
  type AdapterContext,
  type ConnectionRecord,
  type ConnectionSecrets,
  type NormalizedNote,
} from "@note-hub/core";
import { createAdapter } from "@note-hub/adapters";
import { normalizeObsidianNote, normalizeSiyuanNote, normalizeNotionNote, normalizeFeishuNote, referencedAssetPaths } from "@note-hub/normalize";
import { renderPreviewHtml } from "@note-hub/preview";
import { sha256Hex } from "@note-hub/core";
import { query } from "./db.ts";
import { env } from "./env.ts";
import { putHub } from "./s3.ts";
import { runPostSyncGrowth, type UpsertedNote } from "./post-sync-growth.ts";

type ProcessResult =
  | { status: "skip" }
  | { status: "delete" }
  | { status: "upsert"; note: UpsertedNote };

async function loadSecrets(conn: ConnectionRecord): Promise<ConnectionSecrets | null> {
  const mode = conn.mode || conn.config?.mode;
  const useMinio = conn.source === "obsidian" || (conn.source === "siyuan" && mode === "workspace");
  const fallback: ConnectionSecrets | null = useMinio
    ? { access_key: env.s3AccessKey, secret_key: env.s3SecretKey }
    : null;
  if (!conn.secrets_ref) return fallback;
  const r = await query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE id = $1", [conn.secrets_ref]);
  if (!r.rows[0]) return fallback;
  return JSON.parse(decryptSecret(r.rows[0].ciphertext, env.hubSecret)) as ConnectionSecrets;
}

function guessContentType(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function upsertBlocks(noteId: string, note: NormalizedNote) {
  const existing = await query<{ id: string; source_block_id: string }>(
    "SELECT id, source_block_id FROM blocks WHERE note_id = $1",
    [noteId],
  );
  const keep = new Set(note.blocks.map((b) => b.source_block_id));
  for (const row of existing.rows) {
    if (!keep.has(row.source_block_id)) {
      await query("DELETE FROM chunks WHERE block_id = $1", [row.id]);
      await query("DELETE FROM blocks WHERE id = $1", [row.id]);
    }
  }
  const idBySource = new Map<string, string>();
  for (const b of note.blocks) {
    const r = await query<{ id: string }>(
      `INSERT INTO blocks (note_id, source_block_id, type, text, order_key, depth)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (note_id, source_block_id)
       DO UPDATE SET type = EXCLUDED.type, text = EXCLUDED.text, order_key = EXCLUDED.order_key, depth = EXCLUDED.depth
       RETURNING id`,
      [noteId, b.source_block_id, b.type, b.text, b.order_key, b.depth],
    );
    idBySource.set(b.source_block_id, r.rows[0].id);
  }
  return idBySource;
}

async function writeChunks(noteId: string, spaceId: string, note: NormalizedNote, blockIds: Map<string, string>) {
  await query("DELETE FROM chunks WHERE note_id = $1", [noteId]);
  let heading = "";
  for (const b of note.blocks) {
    if (b.type === "heading") heading = b.text;
    const text = b.text || b.markdown;
    if (!text.trim()) continue;
    const tokens = toFtsTokens(`${note.title} ${heading} ${text}`);
    const tokenCount = tokens.split(/\s+/).filter(Boolean).length;
    await query(
      `INSERT INTO chunks (note_id, space_id, block_id, heading_path, text, token_count, fts)
       VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('simple', $7))`,
      [noteId, spaceId, blockIds.get(b.source_block_id) ?? null, heading, text, tokenCount, tokens],
    );
  }
}

async function resolveLinks(connectionId: string, fromNoteId: string, note: NormalizedNote) {
  await query("DELETE FROM links WHERE from_note_id = $1", [fromNoteId]);
  for (const l of note.links) {
    let toNoteId: string | null = null;
    if (l.to_source_id) {
      const r = await query<{ id: string }>(
        "SELECT id FROM notes WHERE connection_id = $1 AND source_id = $2 AND deleted_at IS NULL",
        [connectionId, l.to_source_id],
      );
      toNoteId = r.rows[0]?.id ?? null;
    }
    await query(
      `INSERT INTO links (from_note_id, to_note_id, to_source_id, kind, raw)
       VALUES ($1,$2,$3,$4,$5)`,
      [fromNoteId, toNoteId, l.to_source_id ?? null, l.kind, l.raw],
    );
  }
}

async function processNote(
  conn: ConnectionRecord,
  adapter: Adapter,
  ctx: AdapterContext,
  sourceId: string,
  path: string,
): Promise<ProcessResult> {
  const payload = await adapter.fetchNote(ctx, sourceId);
  if (!payload) {
    await query(
      "UPDATE notes SET deleted_at = now(), updated_at = now() WHERE connection_id = $1 AND source_id = $2 AND deleted_at IS NULL",
      [conn.id, sourceId],
    );
    return { status: "delete" };
  }
  const extraAssets = [];
  for (const a of payload.assets ?? []) {
    if (!a.bytes) continue;
    extraAssets.push({
      source_path: a.path,
      content_type: guessContentType(a.path),
      bytes: a.bytes,
      hash: sha256Hex(a.bytes),
    });
  }
  const note =
    conn.source === "siyuan"
      ? normalizeSiyuanNote(payload, conn.id, extraAssets)
      : conn.source === "notion"
        ? normalizeNotionNote(payload, conn.id, extraAssets)
        : conn.source === "feishu"
          ? normalizeFeishuNote(payload, conn.id, extraAssets)
          : normalizeObsidianNote(payload, conn.id, extraAssets);

  const sourceKey = `source/${conn.space_id}/${conn.id}/${payload.path}`;
  const rawBytes = typeof payload.raw === "string" ? new TextEncoder().encode(payload.raw) : payload.raw;
  await putHub(sourceKey, rawBytes, "text/markdown; charset=utf-8");

  const existing = await query<{ id: string; hash: string }>(
    "SELECT id, hash FROM notes WHERE connection_id = $1 AND source_id = $2",
    [conn.id, sourceId],
  );
  const row = existing.rows[0];
  if (row && row.hash === note.hash && !(await isDeleted(row.id))) {
    return { status: "skip" };
  }

  const mdBytes = Buffer.byteLength(note.markdown, "utf8");
  const storage = mdBytes > 1024 * 1024 ? "s3" : "db";
  const dbMarkdown = storage === "s3" ? note.markdown.slice(0, 8192) : note.markdown;

  const upsert = await query<{ id: string }>(
    `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, frontmatter, hash, acl_snapshot, storage, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,NULL,now())
     ON CONFLICT (connection_id, source_id)
     DO UPDATE SET path = EXCLUDED.path, title = EXCLUDED.title, markdown = EXCLUDED.markdown,
       frontmatter = EXCLUDED.frontmatter, hash = EXCLUDED.hash, storage = EXCLUDED.storage,
       deleted_at = NULL, updated_at = now()
     RETURNING id`,
    [
      conn.space_id,
      conn.id,
      note.source_id,
      note.path,
      note.title,
      dbMarkdown,
      JSON.stringify(note.frontmatter),
      note.hash,
      JSON.stringify({ visible_in_space: true }),
      storage,
    ],
  );
  const noteId = upsert.rows[0].id;

  await putHub(`canonical/${conn.space_id}/${noteId}/note.md`, note.markdown, "text/markdown; charset=utf-8");
  const meta = {
    note_id: noteId,
    source_id: note.source_id,
    connection_id: conn.id,
    space_id: conn.space_id,
    title: note.title,
    path: note.path,
    hash: note.hash,
    updated_at: new Date().toISOString(),
    block_index: note.blocks.map((b) => ({
      source_block_id: b.source_block_id,
      type: b.type,
      order_key: b.order_key,
    })),
  };
  await putHub(`canonical/${conn.space_id}/${noteId}/meta.json`, JSON.stringify(meta, null, 2), "application/json");

  await query("DELETE FROM assets WHERE note_id = $1", [noteId]);
  for (const a of note.assets) {
    const name = a.source_path.split("/").pop() ?? a.source_path;
    const s3Key = `canonical/${conn.space_id}/${noteId}/assets/${name}`;
    await putHub(s3Key, a.bytes, a.content_type);
    await query(
      `INSERT INTO assets (note_id, space_id, source_path, content_type, s3_key, hash, bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [noteId, conn.space_id, a.source_path, a.content_type ?? null, s3Key, a.hash, a.bytes.byteLength],
    );
  }

  const blockIds = await upsertBlocks(noteId, note);
  await writeChunks(noteId, conn.space_id, note, blockIds);
  await resolveLinks(conn.id, noteId, note);

  const html = renderPreviewHtml(note, {
    assetBase: `/v1/notes/${noteId}/assets?path=`,
  });
  await putHub(`preview/${conn.space_id}/${noteId}/${note.hash}.html`, html, "text/html; charset=utf-8");
  void referencedAssetPaths;
  return {
    status: "upsert",
    note: {
      noteId,
      path: note.path,
      title: note.title,
      markdown: note.markdown,
      frontmatter: note.frontmatter ?? {},
      hash: note.hash,
    },
  };
}

async function isDeleted(id: string): Promise<boolean> {
  const r = await query<{ deleted_at: string | null }>("SELECT deleted_at FROM notes WHERE id = $1", [id]);
  return Boolean(r.rows[0]?.deleted_at);
}

export async function runSync(connectionId: string): Promise<void> {
  const r = await query("SELECT * FROM connections WHERE id = $1", [connectionId]);
  const conn = r.rows[0] as ConnectionRecord | undefined;
  if (!conn) throw new Error("connection not found");

  const run = await query<{ id: string }>(
    `INSERT INTO sync_run (connection_id, cursor_before) VALUES ($1, $2) RETURNING id`,
    [connectionId, conn.cursor ? JSON.stringify(conn.cursor) : null],
  );
  const runId = run.rows[0].id;
  let upserts = 0, deletes = 0, skipped = 0, failed = 0;

  const log = async (sourceId: string | null, noteId: string | null, level: string, message: string) => {
    await query(
      `INSERT INTO sync_note_log (connection_id, source_id, note_id, level, message) VALUES ($1,$2,$3,$4,$5)`,
      [connectionId, sourceId, noteId, level, message],
    );
  };

  try {
    if (conn.config.e2ee) {
      await query(
        "UPDATE connections SET status = 'encrypted_unreadable', last_error = $2, updated_at = now() WHERE id = $1",
        [connectionId, "e2ee=true"],
      );
      await log(null, null, "warn", "e2ee=true; skip bodies");
      await query(
        "UPDATE sync_run SET finished_at = now(), skipped = 0 WHERE id = $1",
        [runId],
      );
      return;
    }

    const secrets = await loadSecrets(conn);
    const adapter = createAdapter(conn.source);
    const ctx = { connection: conn, secrets, cursor: conn.cursor };
    const probe = await adapter.probe(ctx);
    if (!probe.ok) {
      const status = probe.status ?? "error";
      await query(
        "UPDATE connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
        [connectionId, status, probe.message ?? "probe failed"],
      );
      if (status === "encrypted_unreadable") {
        await log(null, null, "warn", probe.message ?? "encrypted_unreadable");
      }
      throw new Error(probe.message ?? "probe failed");
    }

    const { changes, nextCursor } = await adapter.listChanges(ctx);

    const deletesList = changes.filter((ch) => ch.type === "delete");
    const upsertsList = changes.filter((ch) => ch.type === "upsert");

    for (const ch of deletesList) {
      try {
        await query(
          "UPDATE notes SET deleted_at = now(), updated_at = now() WHERE connection_id = $1 AND source_id = $2 AND deleted_at IS NULL",
          [conn.id, ch.source_id],
        );
        deletes++;
      } catch (e) {
        failed++;
        await log(ch.source_id, null, "error", e instanceof Error ? e.message : String(e));
      }
    }

    const upsertedNotes: UpsertedNote[] = [];
    for (const ch of upsertsList) {
      if (conn.source === "obsidian" && (!ch.path || !isMarkdownPath(ch.path))) continue;
      try {
        const result = await processNote(conn, adapter, ctx, ch.source_id, ch.path ?? ch.source_id);
        if (result.status === "upsert") {
          upserts++;
          upsertedNotes.push(result.note);
        } else if (result.status === "skip") skipped++;
        else deletes++;
      } catch (e) {
        failed++;
        await log(ch.source_id, null, "error", e instanceof Error ? e.message : String(e));
      }
    }

    await query(
      "UPDATE connections SET cursor = $2::jsonb, last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now() WHERE id = $1",
      [connectionId, JSON.stringify(nextCursor)],
    );
    await query(
      `UPDATE sync_run SET finished_at = now(), upserts = $2, deletes = $3, skipped = $4, failed = $5, cursor_after = $6::jsonb WHERE id = $1`,
      [runId, upserts, deletes, skipped, failed, JSON.stringify(nextCursor)],
    );
    console.log(
      JSON.stringify({
        level: "info",
        job_id: `sync:${connectionId}`,
        connection_id: connectionId,
        upserts,
        deletes,
        skipped,
        failed,
      }),
    );
    if (upsertedNotes.length) {
      try {
        await runPostSyncGrowth(conn.space_id, upsertedNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ level: "error", message: "post-sync growth failed", error: msg }));
        await log(null, null, "warn", "post-sync growth: " + msg);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const last = isHubError(e) ? `${e.code}: ${e.message}` : message;
    await query(
      `UPDATE sync_run SET finished_at = now(), upserts = $2, deletes = $3, skipped = $4, failed = $5 WHERE id = $1`,
      [runId, upserts, deletes, skipped, failed],
    );
    await query(
      "UPDATE connections SET last_error = $2, status = 'error', updated_at = now() WHERE id = $1",
      [connectionId, last],
    );
    if (isHubError(e)) return;
    throw e;
  }
}
