import {
  loadAiSettings,
  refreshNoteLinks,
  collectAssetRefs,
  decryptSecret,
  encryptSecret,
  guessContentType,
  isHubError,
  isImagePath,
  resolveNoteSourceUpdatedAt,
  sha256Hex,
  toFtsTokens,
  type Adapter,
  type AdapterContext,
  type ConnectionRecord,
  type ConnectionSecrets,
  type NormalizedBlock,
  type NormalizedNote,
} from "@note-hub/core";
import { createAdapter, decodeObjectKey, mapConnectionObjectKey, mapPool, siyuanBoxConfRel } from "@note-hub/adapters";
import { embedTexts, embeddingModelId, formatVector } from "@note-hub/retrieve";
import { normalizeObsidianNote, normalizeSiyuanNote, normalizeNotionNote, normalizeFeishuNote, referencedAssetPaths } from "@note-hub/normalize";
import { renderPreviewHtml } from "@note-hub/preview";
import { query } from "./db.ts";
import { env } from "./env.ts";
import { putHub } from "./s3.ts";
import { assetHeadingPath, extractAssetText } from "./extract-asset.ts";
import { runPostSyncGrowth, type UpsertedNote } from "./post-sync-growth.ts";
import { runContactsSync } from "./contacts-sync.ts";
import {
  fileChunkCount,
  shouldFlushProgress,
  sumChunksTotal,
  type SyncProgress,
} from "./sync-progress.ts";


const UPSERT_CONCURRENCY = 8;

function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

export async function markZombieSyncRuns(): Promise<void> {
  // Listing-only timeout must exceed slow adapters (SiYuan official S3 ~4min+).
  await query(
    `UPDATE sync_run SET finished_at = now()
     WHERE finished_at IS NULL AND (
       (COALESCE(files_total, 0) = 0 AND started_at < now() - interval '15 minutes')
       OR started_at < now() - interval '45 minutes'
     )`,
  );
}

export async function finishAllUnfinishedSyncRuns(): Promise<void> {
  await query(`UPDATE sync_run SET finished_at = now() WHERE finished_at IS NULL`);
}

async function persistCursorMeta(connectionId: string, nextCursor: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of ["files", "indexId", "repoRoot", "boxNames", "boxes", "keys"] as const) {
    if (nextCursor[key] !== undefined) patch[key] = nextCursor[key];
  }
  if (!Object.keys(patch).length) return;
  await query(
    `UPDATE connections SET cursor = COALESCE(cursor, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
    [connectionId, JSON.stringify(patch)],
  );
}

async function mergeCursorEtag(connectionId: string, sourceId: string, etag: string | null | undefined): Promise<void> {
  if (!sourceId) return;
  if (etag == null || etag === "") {
    await query(
      `UPDATE connections SET
         cursor = jsonb_set(
           COALESCE(cursor, '{}'::jsonb),
           '{etags}',
           COALESCE(cursor->'etags', '{}'::jsonb) - $2::text
         ),
         updated_at = now()
       WHERE id = $1`,
      [connectionId, sourceId],
    );
    return;
  }
  await query(
    `UPDATE connections SET
       cursor = jsonb_set(
         COALESCE(cursor, '{}'::jsonb),
         '{etags}',
         COALESCE(cursor->'etags', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
       ),
       updated_at = now()
     WHERE id = $1`,
    [connectionId, sourceId, etag],
  );
}

type ProcessResult =
  | { status: "skip"; chunkCount: number }
  | { status: "delete"; chunkCount: number }
  | { status: "upsert"; note: UpsertedNote; chunkCount: number };

function basenameOf(path: string): string {
  return path.split("/").pop() || path;
}

function isAssetNote(payload: { kind?: string; source_id: string; path: string }): boolean {
  if (payload.kind === "asset") return true;
  if (payload.source_id.startsWith("asset:")) return true;
  const p = payload.path.toLowerCase();
  if (p.endsWith(".md") || p.endsWith(".sy")) return false;
  return isImagePath(p) || /\.(pdf|docx?)$/i.test(p);
}

function assetExtractBlocks(
  items: { hash: string; filename: string; contentType?: string; text: string }[],
  start: number,
): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  let i = start;
  for (const a of items) {
    const heading = assetHeadingPath(a.filename, a.contentType);
    blocks.push({
      source_block_id: `asset-h:${a.hash}`,
      type: "heading",
      text: heading,
      markdown: `## ${heading}`,
      order_key: i.toString(36).padStart(4, "0"),
      depth: 2,
    });
    i++;
    blocks.push({
      source_block_id: `asset:${a.hash}`,
      type: "embed",
      text: a.text,
      markdown: a.text,
      order_key: i.toString(36).padStart(4, "0"),
      depth: 0,
    });
    i++;
  }
  return blocks;
}

type StoredAsset = {
  hash: string;
  filename: string;
  contentType?: string;
  text: string;
  source_path: string;
};

async function persistAndExtractAssets(
  noteId: string,
  spaceId: string,
  assets: NormalizedNote["assets"],
): Promise<StoredAsset[]> {
  const existing = await query<{
    id: string;
    source_path: string;
    hash: string | null;
    extracted_text: string | null;
    extract_status: string | null;
    s3_key: string;
  }>(
    "SELECT id, source_path, hash, extracted_text, extract_status, s3_key FROM assets WHERE note_id = $1",
    [noteId],
  );
  const keep = new Set(assets.map((a) => a.source_path));
  for (const row of existing.rows) {
    if (!keep.has(row.source_path)) await query("DELETE FROM assets WHERE id = $1", [row.id]);
  }
  const out: StoredAsset[] = [];
  for (const a of assets) {
    const name = basenameOf(a.source_path);
    const s3Key = `canonical/${spaceId}/${noteId}/assets/${name}`;
    const prev = existing.rows.find((r) => r.source_path === a.source_path);
    const image = isImagePath(name) || (a.content_type ?? "").startsWith("image/");
    const sameHash = Boolean(prev && prev.hash === a.hash);
    // Hash-stable images stay pending for the drain. Do not clobber a concurrent OCR write.
    if (sameHash && prev) {
      if (prev.s3_key !== s3Key) await putHub(s3Key, a.bytes, a.content_type);
      await query(
        `UPDATE assets SET content_type = $2, s3_key = $3, hash = $4, bytes = $5 WHERE id = $1`,
        [prev.id, a.content_type ?? null, s3Key, a.hash, a.bytes.byteLength],
      );
      const text = prev.extracted_text ?? (image ? `图片 ${name}` : "");
      out.push({ hash: a.hash, filename: name, contentType: a.content_type, text, source_path: a.source_path });
      continue;
    }
    await putHub(s3Key, a.bytes, a.content_type);
    let text = "";
    let status = "skipped";
    if (image) {
      text = `图片 ${name}`;
      status = "pending";
    } else {
      const extracted = await extractAssetText({ bytes: a.bytes, filename: name, contentType: a.content_type });
      text = extracted.text;
      status = extracted.status;
    }
    if (prev && prev.source_path === a.source_path) {
      await query(
        `UPDATE assets SET content_type = $2, s3_key = $3, hash = $4, bytes = $5, extracted_text = $6, extract_status = $7
         WHERE id = $1`,
        [prev.id, a.content_type ?? null, s3Key, a.hash, a.bytes.byteLength, text, status],
      );
    } else {
      await query(
        `INSERT INTO assets (note_id, space_id, source_path, content_type, s3_key, hash, bytes, extracted_text, extract_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [noteId, spaceId, a.source_path, a.content_type ?? null, s3Key, a.hash, a.bytes.byteLength, text, status],
      );
    }
    out.push({ hash: a.hash, filename: name, contentType: a.content_type, text, source_path: a.source_path });
  }
  return out;
}

async function backfillAssetExtracts(noteId: string, _spaceId: string, _title: string): Promise<number> {
  // Sync skip path must not wait for OCR. Drain handles pending / placeholder.
  const existingAssetChunks = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chunks ch
     INNER JOIN blocks b ON b.id = ch.block_id
     WHERE ch.note_id = $1 AND b.source_block_id LIKE 'asset:%'`,
    [noteId],
  );
  const n = Number(existingAssetChunks.rows[0]?.n ?? 0);
  if (n > 0) return n;
  const hasAssets = await query<{ n: string }>("SELECT count(*)::text AS n FROM assets WHERE note_id = $1", [noteId]);
  if (Number(hasAssets.rows[0]?.n ?? 0) === 0) return 0;
  return refreshNoteAssetChunks(noteId);
}

/** Upsert asset-* blocks only — never delete body blocks/chunks. */
async function upsertAssetBlocksOnly(noteId: string, blocks: NormalizedBlock[]): Promise<Map<string, string>> {
  const keep = new Set(blocks.map((b) => b.source_block_id));
  const existing = await query<{ id: string; source_block_id: string }>(
    "SELECT id, source_block_id FROM blocks WHERE note_id = $1 AND source_block_id LIKE 'asset%'",
    [noteId],
  );
  for (const row of existing.rows) {
    if (!keep.has(row.source_block_id)) {
      await query("DELETE FROM chunks WHERE block_id = $1", [row.id]);
      await query("DELETE FROM blocks WHERE id = $1", [row.id]);
    }
  }
  const idBySource = new Map<string, string>();
  for (const b of blocks) {
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

/** Rewrite only this note's asset chunks + embeddings after OCR. */
export async function refreshNoteAssetChunks(noteId: string): Promise<number> {
  const note = await query<{ space_id: string; title: string }>(
    "SELECT space_id, title FROM notes WHERE id = $1",
    [noteId],
  );
  const row = note.rows[0];
  if (!row) return 0;
  const assets = await query<{
    hash: string | null;
    source_path: string;
    content_type: string | null;
    extracted_text: string | null;
  }>("SELECT hash, source_path, content_type, extracted_text FROM assets WHERE note_id = $1", [noteId]);
  if (!assets.rows.length) return 0;
  const stored: StoredAsset[] = assets.rows.map((a) => {
    const name = basenameOf(a.source_path);
    const fallback = `${isImagePath(name) || (a.content_type ?? "").startsWith("image/") ? "图片" : "附件"} ${name}`;
    return {
      hash: a.hash || "",
      filename: name,
      contentType: a.content_type ?? undefined,
      text: a.extracted_text || fallback,
      source_path: a.source_path,
    };
  });
  const extra = assetExtractBlocks(stored, 1000);
  const fake: NormalizedNote = {
    source_id: "",
    path: "",
    title: row.title,
    markdown: "",
    frontmatter: {},
    hash: "",
    blocks: extra,
    links: [],
    assets: [],
  };
  const ids = await upsertAssetBlocksOnly(noteId, extra);
  return writeAssetChunksOnly(noteId, row.space_id, fake, ids);
}

async function writeAssetChunksOnly(
  noteId: string,
  spaceId: string,
  note: NormalizedNote,
  blockIds: Map<string, string>,
): Promise<number> {
  await query(
    `DELETE FROM chunks WHERE note_id = $1 AND (
       heading_path LIKE '图片/%' OR heading_path LIKE '附件/%'
       OR block_id IN (SELECT id FROM blocks WHERE note_id = $1 AND source_block_id LIKE 'asset%')
     )`,
    [noteId],
  );
  let heading = "";
  const inserted: { id: string; text: string }[] = [];
  for (const b of note.blocks) {
    if (b.type === "heading") heading = b.text;
    const text = b.text || b.markdown;
    if (!text.trim()) continue;
    const tokens = toFtsTokens(`${note.title} ${heading} ${text}`);
    const tokenCount = tokens.split(/\s+/).filter(Boolean).length;
    const row = await query<{ id: string }>(
      `INSERT INTO chunks (note_id, space_id, block_id, heading_path, text, token_count, fts)
       VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('simple', $7))
       RETURNING id`,
      [noteId, spaceId, blockIds.get(b.source_block_id) ?? null, heading, text, tokenCount, tokens],
    );
    if (row.rows[0]?.id) inserted.push({ id: row.rows[0].id, text });
  }
  await writeEmbeddings(inserted, noteId);
  return inserted.length;
}


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

async function writeEmbeddings(rows: { id: string; text: string }[], noteId?: string): Promise<void> {
  if (!rows.length) return;
  try {
    const ai = await loadAiSettings(query, env.hubSecret);
    const endpoint = { baseUrl: ai.base_url, apiKey: ai.api_key, model: ai.embedding_model };
    const vectors = await embedTexts(rows.map((c) => c.text), endpoint);
    const model = embeddingModelId(endpoint);
    for (let i = 0; i < rows.length; i++) {
      const vec = vectors[i];
      if (!vec?.length) continue;
      await query(
        `UPDATE chunks SET embedding = $2::vector, embedding_model = $3, updated_at = now() WHERE id = $1`,
        [rows[i].id, formatVector(vec), model],
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: "error", message: "embed chunks failed", error: msg, note_id: noteId ?? null }));
  }
}

/** Embed chunks whose embedding is still NULL (hash skip / old notes on auto-sync). */
async function embedNullChunks(opts: { noteId?: string; connectionId?: string }): Promise<void> {
  const params: unknown[] = [];
  const where: string[] = ["ch.embedding IS NULL"];
  if (opts.noteId) {
    params.push(opts.noteId);
    where.push(`ch.note_id = $${params.length}`);
  }
  if (opts.connectionId) {
    params.push(opts.connectionId);
    where.push(`n.connection_id = $${params.length}`);
    where.push("n.deleted_at IS NULL");
  }
  const r = await query<{ id: string; text: string }>(
    `SELECT ch.id, ch.text
     FROM chunks ch
     INNER JOIN notes n ON n.id = ch.note_id
     WHERE ${where.join(" AND ")}`,
    params,
  );
  await writeEmbeddings(r.rows, opts.noteId);
}

async function writeChunks(noteId: string, spaceId: string, note: NormalizedNote, blockIds: Map<string, string>): Promise<number> {
  await query("DELETE FROM chunks WHERE note_id = $1", [noteId]);
  let heading = "";
  const inserted: { id: string; text: string }[] = [];
  for (const b of note.blocks) {
    if (b.type === "heading") heading = b.text;
    const text = b.text || b.markdown;
    if (!text.trim()) continue;
    const tokens = toFtsTokens(`${note.title} ${heading} ${text}`);
    const tokenCount = tokens.split(/\s+/).filter(Boolean).length;
    const row = await query<{ id: string }>(
      `INSERT INTO chunks (note_id, space_id, block_id, heading_path, text, token_count, fts)
       VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('simple', $7))
       RETURNING id`,
      [noteId, spaceId, blockIds.get(b.source_block_id) ?? null, heading, text, tokenCount, tokens],
    );
    if (row.rows[0]?.id) inserted.push({ id: row.rows[0].id, text });
  }
  await writeEmbeddings(inserted, noteId);
  return inserted.length;
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
    // Feishu/SiYuan emit explicit delete changes from listChanges. A null fetch on an
    // upsert is almost always transient (timeout / decrypt miss) — soft-deleting here
    // caused Feishu delete↔upsert churn and wiped SiYuan notes after S3 blips.
    if (conn.source === "feishu" || conn.source === "siyuan") {
      throw new Error(`fetchNote returned null for ${sourceId}`);
    }
    await query(
      "UPDATE notes SET deleted_at = now(), updated_at = now() WHERE connection_id = $1 AND source_id = $2 AND deleted_at IS NULL",
      [conn.id, sourceId],
    );
    return { status: "delete", chunkCount: 0 };
  }
  const extraAssets = [];
  const seenAssets = new Set<string>();
  for (const a of payload.assets ?? []) {
    if (!a.bytes) continue;
    extraAssets.push({
      source_path: a.path,
      content_type: a.contentType || guessContentType(a.path),
      bytes: a.bytes,
      hash: sha256Hex(a.bytes),
    });
    seenAssets.add(a.path);
    seenAssets.add(basenameOf(a.path));
  }
  const rawText = typeof payload.raw === "string" ? payload.raw : "";
  const refs = new Set([...referencedAssetPaths(rawText, payload.path), ...collectAssetRefs(rawText)]);
  for (const ref of refs) {
    if (seenAssets.has(ref) || seenAssets.has(basenameOf(ref))) continue;
    try {
      const bytes = await adapter.fetchAsset(ctx, ref);
      if (!bytes?.byteLength) continue;
      extraAssets.push({
        source_path: ref,
        content_type: guessContentType(ref),
        bytes,
        hash: sha256Hex(bytes),
      });
      seenAssets.add(ref);
    } catch {
      /* missing attachment is not fatal */
    }
  }
  let note =
    conn.source === "siyuan"
      ? normalizeSiyuanNote(payload, conn.id, extraAssets)
      : conn.source === "notion"
        ? normalizeNotionNote(payload, conn.id, extraAssets)
        : conn.source === "feishu"
          ? normalizeFeishuNote(payload, conn.id, extraAssets)
          : normalizeObsidianNote(payload, conn.id, extraAssets);
  const assetOnly = isAssetNote(payload);
  if (assetOnly && extraAssets[0]) {
    note = { ...note, hash: extraAssets[0].hash, assets: extraAssets };
    const name = basenameOf(extraAssets[0].source_path);
    const md = isImagePath(name) ? `# ${name}\n\n![${name}](${name})\n` : `# ${name}\n\n[${name}](${name})\n`;
    note = { ...note, markdown: md, title: note.title || name };
  }
  const sourceUpdatedAt = resolveNoteSourceUpdatedAt({
    source: conn.source,
    payload,
    frontmatter: note.frontmatter,
  });

  const sourceKey = `source/${conn.space_id}/${conn.id}/${payload.path}`;
  const rawBytes = typeof payload.raw === "string" ? new TextEncoder().encode(payload.raw) : payload.raw;
  await putHub(sourceKey, rawBytes, "text/markdown; charset=utf-8");

  const existing = await query<{ id: string; hash: string }>(
    "SELECT id, hash FROM notes WHERE connection_id = $1 AND source_id = $2",
    [conn.id, sourceId],
  );
  const row = existing.rows[0];
  if (row && row.hash === note.hash && !(await isDeleted(row.id))) {
    if (extraAssets.length) {
      const existingAssets = await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM assets WHERE note_id = $1",
        [row.id],
      );
      if (Number(existingAssets.rows[0]?.n ?? 0) === 0) {
        await persistAndExtractAssets(row.id, conn.space_id, extraAssets);
      }
    }
    await query("UPDATE notes SET source_updated_at = $2 WHERE id = $1", [row.id, sourceUpdatedAt.toISOString()]);
    await embedNullChunks({ noteId: row.id });
    await backfillAssetExtracts(row.id, conn.space_id, note.title);
    await refreshNoteLinks(query, { id: row.id, spaceId: conn.space_id, connectionId: conn.id, source: conn.source, sourceId: note.source_id, path: note.path, markdown: note.markdown });
    const existingChunks = await query<{ n: string }>("SELECT count(*)::text AS n FROM chunks WHERE note_id = $1", [row.id]);
    return { status: "skip", chunkCount: Number(existingChunks.rows[0]?.n ?? 0) };
  }

  const mdBytes = Buffer.byteLength(note.markdown, "utf8");
  const storage = mdBytes > 1024 * 1024 ? "s3" : "db";
  const dbMarkdown = storage === "s3" ? note.markdown.slice(0, 8192) : note.markdown;

  const upsert = await query<{ id: string }>(
    `INSERT INTO notes (space_id, connection_id, source_id, path, title, markdown, frontmatter, hash, acl_snapshot, storage, deleted_at, source_updated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,NULL,$11,now())
     ON CONFLICT (connection_id, source_id)
     DO UPDATE SET path = EXCLUDED.path, title = EXCLUDED.title, markdown = EXCLUDED.markdown,
       frontmatter = EXCLUDED.frontmatter, hash = EXCLUDED.hash, storage = EXCLUDED.storage,
       deleted_at = NULL, source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
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
      JSON.stringify({ visibility: "space", visible_in_space: true, user_ids: [], roles: [] }),
      storage,
      sourceUpdatedAt.toISOString(),
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

  const storedAssets = await persistAndExtractAssets(noteId, conn.space_id, note.assets);
  if (storedAssets.length) {
    const extraBlocks = assetExtractBlocks(storedAssets, note.blocks.length);
    note = { ...note, blocks: [...note.blocks, ...extraBlocks] };
    if (assetOnly && storedAssets[0]?.text) {
      const combined = `${note.markdown.trimEnd()}\n\n${storedAssets[0].text}\n`;
      note = { ...note, markdown: combined };
      await query("UPDATE notes SET markdown = $2 WHERE id = $1", [noteId, combined.slice(0, 1024 * 1024)]);
    }
  }

  const blockIds = await upsertBlocks(noteId, note);
  const chunkCount = await writeChunks(noteId, conn.space_id, note, blockIds);
  await resolveLinks(conn.id, noteId, note);
  const linkRows = await refreshNoteLinks(query, { id: noteId, spaceId: conn.space_id, connectionId: conn.id, source: conn.source, sourceId: note.source_id, path: note.path, markdown: note.markdown });
  const backlinkRows = await query<{ note_id: string; title: string; path: string }>(
    `SELECT DISTINCT ON (n.id) n.id AS note_id, n.title, n.path
     FROM note_links l
     INNER JOIN notes n ON n.id = l.source_note_id AND n.deleted_at IS NULL
     WHERE l.target_note_id = $1
     ORDER BY n.id, n.title`,
    [noteId],
  );

  const html = renderPreviewHtml(note, {
    assetBase: `/v1/notes/${noteId}/assets?path=`,
    links: linkRows.map((row) => ({
      raw: row.raw,
      label: row.label,
      targetNoteId: row.targetNoteId,
      heading: row.heading,
    })),
    backlinks: backlinkRows.rows.map((row) => ({
      noteId: row.note_id,
      title: row.title,
      path: row.path,
    })),
  });
  await putHub(`preview/${conn.space_id}/${noteId}/${note.hash}.html`, html, "text/html; charset=utf-8");
  return {
    status: "upsert",
    chunkCount,
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

export type RunSyncOpts = { keys?: string[] };

type Tallies = { upserts: number; deletes: number; skipped: number; failed: number };

async function writeSyncProgress(
  runId: string,
  progress: SyncProgress,
  tallies?: Tallies,
  opts?: { finished?: boolean; cursorAfter?: Record<string, unknown> | null },
): Promise<void> {
  const finished = Boolean(opts?.finished);
  const cursorAfter = opts?.cursorAfter;
  const upserts = tallies?.upserts ?? 0;
  const deletes = tallies?.deletes ?? 0;
  const skipped = tallies?.skipped ?? 0;
  const failed = tallies?.failed ?? 0;
  if (finished && cursorAfter !== undefined) {
    await query(
      `UPDATE sync_run SET finished_at = now(), upserts = $2, deletes = $3, skipped = $4, failed = $5,
         files_total = $6, files_done = $7, chunks_total = $8, chunks_done = $9, cursor_after = $10::jsonb
       WHERE id = $1`,
      [
        runId,
        upserts,
        deletes,
        skipped,
        failed,
        progress.filesTotal,
        progress.filesDone,
        progress.chunksTotal,
        progress.chunksDone,
        cursorAfter ? JSON.stringify(cursorAfter) : null,
      ],
    );
    return;
  }
  if (finished) {
    await query(
      `UPDATE sync_run SET finished_at = now(), upserts = $2, deletes = $3, skipped = $4, failed = $5,
         files_total = $6, files_done = $7, chunks_total = $8, chunks_done = $9
       WHERE id = $1`,
      [
        runId,
        upserts,
        deletes,
        skipped,
        failed,
        progress.filesTotal,
        progress.filesDone,
        progress.chunksTotal,
        progress.chunksDone,
      ],
    );
    return;
  }
  await query(
    `UPDATE sync_run SET upserts = $2, deletes = $3, skipped = $4, failed = $5,
       files_total = $6, files_done = $7, chunks_total = $8, chunks_done = $9
     WHERE id = $1`,
    [
      runId,
      upserts,
      deletes,
      skipped,
      failed,
      progress.filesTotal,
      progress.filesDone,
      progress.chunksTotal,
      progress.chunksDone,
    ],
  );
}

function createProgressWriter(runId: string, tallies: Tallies) {
  let lastFlushAt = 0;
  let filesSinceFlush = 0;
  return {
    async persist(progress: SyncProgress): Promise<void> {
      await writeSyncProgress(runId, progress, tallies);
      lastFlushAt = Date.now();
      filesSinceFlush = 0;
    },
    async afterFile(progress: SyncProgress): Promise<void> {
      filesSinceFlush++;
      const now = Date.now();
      if (shouldFlushProgress(filesSinceFlush, lastFlushAt, now)) {
        await writeSyncProgress(runId, progress, tallies);
        lastFlushAt = now;
        filesSinceFlush = 0;
      }
    },
    async finish(progress: SyncProgress, cursorAfter?: Record<string, unknown> | null): Promise<void> {
      await writeSyncProgress(runId, progress, tallies, { finished: true, cursorAfter });
    },
  };
}

/** True once the connection row is gone (deleted mid-flight). */
async function connectionGone(connectionId: string): Promise<boolean> {
  const r = await query("SELECT 1 FROM connections WHERE id = $1", [connectionId]);
  return (r.rowCount ?? 0) === 0;
}

/** Throttled "was this connection deleted?" probe, so a long run can bail out cheaply. */
function createGoneWatch(connectionId: string, everyMs = 2000): () => Promise<boolean> {
  let checkedAt = 0;
  let gone = false;
  return async () => {
    if (gone) return true;
    const now = Date.now();
    if (now - checkedAt < everyMs) return false;
    checkedAt = now;
    gone = await connectionGone(connectionId);
    return gone;
  };
}

function logAborted(connectionId: string, where: string): void {
  console.log(
    JSON.stringify({
      level: "info",
      message: "connection deleted; sync aborted",
      connection_id: connectionId,
      where,
    }),
  );
}

export async function runSync(connectionId: string, opts: RunSyncOpts = {}): Promise<void> {
  const r = await query("SELECT * FROM connections WHERE id = $1", [connectionId]);
  const conn = r.rows[0] as ConnectionRecord | undefined;
  // Deleted while the job sat in the queue: nothing to sync, and failing the job would be noise.
  if (!conn) {
    logAborted(connectionId, "queued");
    return;
  }

  const earlier = await query<{ id: string }>(
    `SELECT id FROM sync_run
     WHERE connection_id = $1 AND finished_at IS NULL
     ORDER BY started_at ASC
     LIMIT 1`,
    [connectionId],
  );
  if (earlier.rows[0]) return;

  const run = await query<{ id: string }>(
    `INSERT INTO sync_run (connection_id, cursor_before) VALUES ($1, $2) RETURNING id`,
    [connectionId, conn.cursor ? JSON.stringify(conn.cursor) : null],
  );
  const runId = run.rows[0].id;
  const raced = await query<{ id: string }>(
    `SELECT id FROM sync_run
     WHERE connection_id = $1 AND finished_at IS NULL AND id <> $2
       AND started_at <= (SELECT started_at FROM sync_run WHERE id = $2)
     ORDER BY started_at ASC, id ASC
     LIMIT 1`,
    [connectionId, runId],
  );
  if (raced.rows[0]) {
    await query(`UPDATE sync_run SET finished_at = now() WHERE id = $1 AND finished_at IS NULL`, [runId]);
    return;
  }
  const tallies: Tallies = { upserts: 0, deletes: 0, skipped: 0, failed: 0 };
  const progress: SyncProgress = { filesTotal: 0, filesDone: 0, chunksTotal: 0, chunksDone: 0 };
  const writer = createProgressWriter(runId, tallies);

  const goneWatch = createGoneWatch(connectionId);

  const log = async (sourceId: string | null, noteId: string | null, level: string, message: string) => {
    try {
      await query(
        `INSERT INTO sync_note_log (connection_id, source_id, note_id, level, message) VALUES ($1,$2,$3,$4,$5)`,
        [connectionId, sourceId, noteId, level, message],
      );
    } catch {
      /* connection may have been deleted mid-run; a log row is not worth failing the job */
    }
  };

  try {
    if (conn.config.e2ee) {
      await query(
        "UPDATE connections SET status = 'encrypted_unreadable', last_error = $2, updated_at = now() WHERE id = $1",
        [connectionId, "e2ee=true"],
      );
      await log(null, null, "warn", "e2ee=true; skip bodies");
      await writer.finish(progress);
      return;
    }

    const secrets = await loadSecrets(conn);
    const adapter = createAdapter(conn.source);
    const ctx = {
      connection: conn,
      secrets,
      cursor: conn.cursor,
      persistSecrets: async (next: ConnectionSecrets) => {
        const blob = encryptSecret(JSON.stringify(next), env.hubSecret);
        const s = await query<{ id: string }>("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
        await query("UPDATE connections SET secrets_ref = $2, updated_at = now() WHERE id = $1", [
          connectionId,
          s.rows[0].id,
        ]);
      },
    };
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

    const fileKeys = (opts.keys ?? []).map(decodeObjectKey).filter(Boolean);
    if (fileKeys.length) {
      const upsertedNotes: UpsertedNote[] = [];
      await ingestFileKeys(conn, adapter, ctx, fileKeys, log, tallies, upsertedNotes, progress, writer, goneWatch);
      if (await connectionGone(connectionId)) {
        logAborted(connectionId, "file-sync");
        return;
      }
      await query(
        "UPDATE connections SET last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now() WHERE id = $1",
        [connectionId],
      );
      await writer.finish(progress);
      console.log(
        JSON.stringify({
          level: "info",
          job_id: `syncfile-${connectionId}`,
          connection_id: connectionId,
          keys: fileKeys.length,
          upserts: tallies.upserts,
          deletes: tallies.deletes,
          skipped: tallies.skipped,
          failed: tallies.failed,
          files_total: progress.filesTotal,
          files_done: progress.filesDone,
          chunks_total: progress.chunksTotal,
          chunks_done: progress.chunksDone,
        }),
      );
      await embedNullChunks({ connectionId: conn.id });
      if (upsertedNotes.length) {
        try {
          await runPostSyncGrowth(conn.space_id, upsertedNotes);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(JSON.stringify({ level: "error", message: "post-sync growth failed", error: msg }));
          await log(null, null, "warn", "post-sync growth: " + msg);
        }
      }
      return;
    }

    const { changes, nextCursor } = await adapter.listChanges(ctx);
    const cursor = nextCursor as Record<string, unknown>;
    ctx.cursor = { ...((ctx.cursor ?? {}) as Record<string, unknown>), ...cursor };
    await persistCursorMeta(connectionId, cursor);

    const deletesList = changes.filter((ch) => ch.type === "delete");
    const upsertsList = changes.filter((ch) => ch.type === "upsert");

    progress.filesTotal = upsertsList.length;
    const chunkCounts: Record<string, number | undefined> = {};
    for (const ch of upsertsList) {
      if (typeof ch.chunk_count === "number") chunkCounts[ch.source_id] = ch.chunk_count;
    }
    progress.chunksTotal = sumChunksTotal(
      upsertsList.map((ch) => ch.source_id),
      cursor,
      chunkCounts,
    );
    await writer.persist(progress);

    for (const ch of deletesList) {
      try {
        await query(
          "UPDATE notes SET deleted_at = now(), updated_at = now() WHERE connection_id = $1 AND source_id = $2 AND deleted_at IS NULL",
          [conn.id, ch.source_id],
        );
        tallies.deletes++;
        await mergeCursorEtag(connectionId, ch.source_id, null);
      } catch (e) {
        tallies.failed++;
        await log(ch.source_id, null, "error", e instanceof Error ? e.message : String(e));
      }
    }

    const upsertedNotes: UpsertedNote[] = [];
    const lock = createMutex();
    await mapPool(upsertsList, UPSERT_CONCURRENCY, async (ch) => {
      // Deleted mid-sync: stop touching rows that no longer have a parent connection.
      if (await goneWatch()) return;
      try {
        const result = await processNote(conn, adapter, ctx, ch.source_id, ch.path ?? ch.source_id);
        await lock.run(async () => {
          if (result.status === "upsert") {
            tallies.upserts++;
            upsertedNotes.push(result.note);
          } else if (result.status === "skip") tallies.skipped++;
          else tallies.deletes++;
          progress.chunksDone += fileChunkCount(ch.source_id, {
            cursor,
            chunkCount: ch.chunk_count,
            processed: result.chunkCount,
          });
          const etag = ch.etag ?? (typeof cursor.etags === "object" && cursor.etags && !Array.isArray(cursor.etags)
            ? (cursor.etags as Record<string, string>)[ch.source_id]
            : undefined);
          if (etag) await mergeCursorEtag(connectionId, ch.source_id, etag);
          progress.filesDone++;
          await writer.afterFile(progress);
        });
      } catch (e) {
        await lock.run(async () => {
          tallies.failed++;
          await log(ch.source_id, null, "error", e instanceof Error ? e.message : String(e));
          progress.filesDone++;
          await writer.afterFile(progress);
        });
      }
    });

    if (await connectionGone(connectionId)) {
      logAborted(connectionId, "full-sync");
      return;
    }
    // persistCursorMeta only keeps Siyuan/box meta keys (files/indexId/…).
    // Notion uses last_edited_time; Feishu stores per-doc objToken→edit (+ __meta).
    // Write those watermarks only when nothing failed, otherwise a partial run
    // would skip unprocessed pages forever on the next incremental sync.
    if (tallies.failed === 0 && conn.source === "feishu") {
      // Full replace: nextCursor is the complete live wiki/doc edit map.
      await query(
        `UPDATE connections SET
           cursor = $2::jsonb,
           last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now()
         WHERE id = $1`,
        [connectionId, JSON.stringify(cursor)],
      );
    } else if (tallies.failed === 0 && conn.source === "siyuan" && cursor.etags && typeof cursor.etags === "object") {
      // Bulk-write etags (+ meta already via persistCursorMeta). Avoid relying only on
      // per-file jsonb_set against a multi-MB official cursor.
      const siyuanPatch: Record<string, unknown> = { etags: cursor.etags };
      for (const key of ["files", "indexId", "repoRoot", "boxNames", "boxes", "keys"] as const) {
        if (cursor[key] !== undefined) siyuanPatch[key] = cursor[key];
      }
      await query(
        `UPDATE connections SET
           cursor = COALESCE(cursor, '{}'::jsonb) || $2::jsonb,
           last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now()
         WHERE id = $1`,
        [connectionId, JSON.stringify(siyuanPatch)],
      );
    } else {
      const watermarkPatch: Record<string, unknown> = {};
      if (tallies.failed === 0 && typeof cursor.last_edited_time === "string" && cursor.last_edited_time) {
        watermarkPatch.last_edited_time = cursor.last_edited_time;
      }
      if (Object.keys(watermarkPatch).length) {
        await query(
          `UPDATE connections SET
             cursor = COALESCE(cursor, '{}'::jsonb) || $2::jsonb,
             last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now()
           WHERE id = $1`,
          [connectionId, JSON.stringify(watermarkPatch)],
        );
      } else {
        await query(
          "UPDATE connections SET last_sync_at = now(), last_error = NULL, status = 'active', updated_at = now() WHERE id = $1",
          [connectionId],
        );
      }
    }
    try {
      await writer.finish(progress, cursor);
    } catch (finishErr) {
      // Huge official SiYuan cursors (~3MB+) have blown up cursor_after writes; still close the run.
      console.error(JSON.stringify({
        level: "error",
        message: "sync_run cursor_after write failed; finishing without cursor",
        connection_id: connectionId,
        error: finishErr instanceof Error ? finishErr.message : String(finishErr),
      }));
      await writer.finish(progress);
    }
    console.log(
      JSON.stringify({
        level: "info",
        job_id: `sync:${connectionId}`,
        connection_id: connectionId,
        upserts: tallies.upserts,
        deletes: tallies.deletes,
        skipped: tallies.skipped,
        failed: tallies.failed,
        files_total: progress.filesTotal,
        files_done: progress.filesDone,
        chunks_total: progress.chunksTotal,
        chunks_done: progress.chunksDone,
      }),
    );
    await embedNullChunks({ connectionId: conn.id });
    if (conn.source === "feishu" && !(opts.keys && opts.keys.length)) {
      try {
        await runContactsSync(connectionId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ level: "error", message: "feishu contacts sync failed", connection_id: connectionId, error: msg }));
        await log(null, null, "warn", "contacts sync: " + msg);
      }
    }
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
    if (await connectionGone(connectionId)) {
      logAborted(connectionId, "error-path");
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const last = isHubError(e) ? `${e.code}: ${e.message}` : message;
    await writer.finish(progress);
    await query(
      "UPDATE connections SET last_error = $2, status = 'error', updated_at = now() WHERE id = $1",
      [connectionId, last],
    );
    if (isHubError(e)) return;
    throw e;
  }
}


async function siyuanBoxEncrypted(adapter: Adapter, ctx: AdapterContext, boxId: string): Promise<boolean> {
  if (!boxId) return false;
  try {
    const bytes = await adapter.fetchAsset(ctx, siyuanBoxConfRel(boxId));
    if (!bytes?.byteLength) return false;
    const conf = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return conf.encrypted === true || conf.encrypted === "true";
  } catch {
    return false;
  }
}

async function applyNote(
  conn: ConnectionRecord,
  adapter: Adapter,
  ctx: AdapterContext,
  sourceId: string,
  path: string,
  log: (sourceId: string | null, noteId: string | null, level: string, message: string) => Promise<void>,
  tallies: Tallies,
  upsertedNotes: UpsertedNote[],
): Promise<number> {
  try {
    const result = await processNote(conn, adapter, ctx, sourceId, path);
    if (result.status === "upsert") {
      tallies.upserts++;
      upsertedNotes.push(result.note);
    } else if (result.status === "skip") tallies.skipped++;
    else tallies.deletes++;
    return result.chunkCount;
  } catch (e) {
    tallies.failed++;
    await log(sourceId, null, "error", e instanceof Error ? e.message : String(e));
    return 0;
  }
}

async function referringNotes(connectionId: string, assetPath: string): Promise<{ source_id: string; path: string }[]> {
  const r = await query<{ source_id: string; path: string; markdown: string | null }>(
    `SELECT source_id, path, markdown FROM notes WHERE connection_id = $1 AND deleted_at IS NULL`,
    [connectionId],
  );
  const base = assetPath.split("/").pop() ?? assetPath;
  const out: { source_id: string; path: string }[] = [];
  for (const row of r.rows) {
    const md = row.markdown ?? "";
    if (md.includes(assetPath) || (base && md.includes(base)) || row.path === assetPath) {
      out.push({ source_id: row.source_id, path: row.path });
    }
  }
  const viaAssets = await query<{ source_id: string; path: string }>(
    `SELECT n.source_id, n.path FROM notes n
     INNER JOIN assets a ON a.note_id = n.id
     WHERE n.connection_id = $1 AND n.deleted_at IS NULL AND a.source_path = $2`,
    [connectionId, assetPath],
  );
  const seen = new Set(out.map((x) => x.source_id));
  for (const row of viaAssets.rows) {
    if (!seen.has(row.source_id)) out.push(row);
  }
  return out;
}

type ProgressWriter = ReturnType<typeof createProgressWriter>;

async function ingestFileKeys(
  conn: ConnectionRecord,
  adapter: Adapter,
  baseCtx: AdapterContext,
  keys: string[],
  log: (sourceId: string | null, noteId: string | null, level: string, message: string) => Promise<void>,
  tallies: Tallies,
  upsertedNotes: UpsertedNote[],
  progress: SyncProgress,
  writer: ProgressWriter,
  goneWatch?: () => Promise<boolean>,
): Promise<void> {
  progress.filesTotal = keys.length;
  progress.chunksTotal = 0;
  await writer.persist(progress);
  const cursor = (baseCtx.cursor ?? conn.cursor) as Record<string, unknown> | null;

  for (const key of keys) {
    if (goneWatch && (await goneWatch())) break;
    const mapped = mapConnectionObjectKey(conn, key);
    if (!mapped || mapped.kind === "skip") {
      tallies.skipped++;
      progress.filesDone++;
      await writer.afterFile(progress);
      continue;
    }
    if (conn.source === "siyuan" && mapped.boxId) {
      if (await siyuanBoxEncrypted(adapter, baseCtx, mapped.boxId)) {
        tallies.skipped++;
        await log(mapped.source_id, null, "warn", "encrypted notebook skipped");
        progress.filesDone++;
        await writer.afterFile(progress);
        continue;
      }
    }
    const ctx: AdapterContext = { ...baseCtx, objectKey: mapped.objectKey };
    if (mapped.kind === "asset") {
      const processedAsset = await applyNote(conn, adapter, ctx, mapped.source_id, mapped.path, log, tallies, upsertedNotes);
      progress.chunksDone += fileChunkCount(mapped.source_id, { cursor, processed: processedAsset });
      const refs = await referringNotes(conn.id, mapped.path);
      for (const n of refs) {
        if (n.source_id === mapped.source_id) continue;
        const processed = await applyNote(conn, adapter, ctx, n.source_id, n.path, log, tallies, upsertedNotes);
        progress.chunksDone += fileChunkCount(n.source_id, { cursor, processed });
      }
      progress.filesDone++;
      await writer.afterFile(progress);
      continue;
    }
    const processed = await applyNote(conn, adapter, ctx, mapped.source_id, mapped.path, log, tallies, upsertedNotes);
    progress.chunksDone += fileChunkCount(mapped.source_id, { cursor, processed });
    progress.filesDone++;
    await writer.afterFile(progress);
  }
}

export async function runSyncFiles(connectionId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await runSync(connectionId, { keys });
}
