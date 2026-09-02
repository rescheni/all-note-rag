import { mapPool } from "@note-hub/adapters";
import { query } from "./db.ts";
import { getHub } from "./s3.ts";
import {
  extractAssetText,
  isPlaceholderExtract,
  needsExtract,
  type ExtractResult,
} from "./extract-asset.ts";
import { refreshNoteAssetChunks } from "./sync.ts";

export const EXTRACT_BATCH_SIZE = 12;
export const EXTRACT_OCR_CONCURRENCY = 2;
export const EXTRACT_MAX_ATTEMPTS = 5;

export type DrainExtractFn = (opts: {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
}) => Promise<ExtractResult>;

export type DrainGetBytes = (key: string) => Promise<Uint8Array | null>;

export type DrainResult = {
  processed: number;
  ok: number;
  empty: number;
  error: number;
  skipped: number;
  pendingLeft: number;
};

type ClaimedAsset = {
  id: string;
  note_id: string;
  space_id: string;
  source_path: string;
  hash: string | null;
  extracted_text: string | null;
  content_type: string | null;
  s3_key: string;
  extract_attempts: number;
};

function basenameOf(path: string): string {
  return path.split("/").pop() || path;
}

export async function recoverStaleExtracts(): Promise<number> {
  const r = await query(
    `UPDATE assets SET extract_status = 'pending', extract_updated_at = now()
     WHERE extract_status = 'running'`,
  );
  return r.rowCount ?? 0;
}

export async function claimPendingAssets(opts?: {
  limit?: number;
  noteId?: string;
}): Promise<ClaimedAsset[]> {
  const limit = opts?.limit ?? EXTRACT_BATCH_SIZE;
  const r = await query<ClaimedAsset>(
    `WITH due AS (
       SELECT id FROM assets
       WHERE (
         extract_status = 'pending'
         OR (
           extract_status = 'error'
           AND extract_attempts < $2
           AND COALESCE(extract_updated_at, created_at) < now() - interval '15 minutes'
         )
         OR (
           extract_status = 'running'
           AND COALESCE(extract_updated_at, created_at) < now() - interval '5 minutes'
         )
       )
       AND ($3::uuid IS NULL OR note_id = $3)
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE assets AS a
     SET extract_status = 'running', extract_updated_at = now()
     FROM due
     WHERE a.id = due.id
     RETURNING a.id, a.note_id, a.space_id, a.source_path, a.hash, a.extracted_text,
               a.content_type, a.s3_key, a.extract_attempts`,
    [limit, EXTRACT_MAX_ATTEMPTS, opts?.noteId ?? null],
  );
  return r.rows;
}

async function markAsset(
  id: string,
  text: string,
  status: string,
  attempts: number,
): Promise<void> {
  await query(
    `UPDATE assets
     SET extracted_text = $2, extract_status = $3, extract_attempts = $4, extract_updated_at = now()
     WHERE id = $1`,
    [id, text, status, attempts],
  );
}

function fallbackName(filename: string, contentType?: string | null): string {
  const image = (contentType ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
  return `${image ? "图片" : "附件"} ${filename}`;
}

export async function processClaimedAsset(
  row: ClaimedAsset,
  opts?: { extract?: DrainExtractFn; getBytes?: DrainGetBytes },
): Promise<{ noteId: string; status: string; changed: boolean }> {
  const hash = row.hash || "";
  const name = basenameOf(row.source_path);
  const extract = opts?.extract ?? extractAssetText;
  const getBytes = opts?.getBytes ?? getHub;

  if (
    !needsExtract(
      { hash: row.hash, extracted_text: row.extracted_text, extract_status: "ok" },
      hash,
    ) &&
    row.extracted_text &&
    !isPlaceholderExtract(row.extracted_text)
  ) {
    await markAsset(row.id, row.extracted_text, "ok", 0);
    return { noteId: row.note_id, status: "skipped", changed: false };
  }

  let bytes: Uint8Array | null = null;
  try {
    bytes = await getBytes(row.s3_key);
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "warn",
        message: "extract getHub failed",
        asset_id: row.id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  if (!bytes?.byteLength) {
    const text = row.extracted_text || fallbackName(name, row.content_type);
    await markAsset(row.id, text, "error", (row.extract_attempts ?? 0) + 1);
    return { noteId: row.note_id, status: "error", changed: false };
  }

  let extracted: ExtractResult;
  try {
    extracted = await extract({
      bytes,
      filename: name,
      contentType: row.content_type ?? undefined,
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "warn",
        message: "extractAssetText threw",
        asset_id: row.id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    const text = row.extracted_text || fallbackName(name, row.content_type);
    await markAsset(row.id, text, "error", (row.extract_attempts ?? 0) + 1);
    return { noteId: row.note_id, status: "error", changed: false };
  }

  const status = extracted.status === "ok" || extracted.status === "empty" || extracted.status === "skipped"
    ? extracted.status
    : "error";
  const text = extracted.text?.trim()
    ? extracted.text
    : (row.extracted_text || fallbackName(name, row.content_type));
  const attempts = status === "error" ? (row.extract_attempts ?? 0) + 1 : 0;
  await markAsset(row.id, text, status, attempts);
  const changed = text !== (row.extracted_text ?? "");
  return { noteId: row.note_id, status, changed };
}

export async function drainExtractBatch(opts?: {
  limit?: number;
  noteId?: string;
  extract?: DrainExtractFn;
  getBytes?: DrainGetBytes;
  concurrency?: number;
}): Promise<DrainResult> {
  const claimed = await claimPendingAssets({ limit: opts?.limit, noteId: opts?.noteId });
  const tallies = { processed: 0, ok: 0, empty: 0, error: 0, skipped: 0, pendingLeft: 0 };
  if (!claimed.length) {
    const left = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM assets WHERE extract_status = 'pending'${opts?.noteId ? " AND note_id = $1" : ""}`,
      opts?.noteId ? [opts.noteId] : [],
    );
    tallies.pendingLeft = Number(left.rows[0]?.n ?? 0);
    return tallies;
  }

  const notesToRefresh = new Set<string>();
  const concurrency = opts?.concurrency ?? EXTRACT_OCR_CONCURRENCY;
  const results = await mapPool(claimed, concurrency, async (row) => processClaimedAsset(row, opts));
  for (const r of results) {
    tallies.processed++;
    if (r.status === "ok") tallies.ok++;
    else if (r.status === "empty") tallies.empty++;
    else if (r.status === "error") tallies.error++;
    else tallies.skipped++;
    if (r.changed) notesToRefresh.add(r.noteId);
  }

  for (const noteId of notesToRefresh) {
    try {
      await refreshNoteAssetChunks(noteId);
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "refresh asset chunks failed",
          note_id: noteId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  const left = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM assets WHERE extract_status = 'pending'${opts?.noteId ? " AND note_id = $1" : ""}`,
    opts?.noteId ? [opts.noteId] : [],
  );
  tallies.pendingLeft = Number(left.rows[0]?.n ?? 0);
  console.log(
    JSON.stringify({
      level: "info",
      message: "extract drain batch",
      processed: tallies.processed,
      ok: tallies.ok,
      empty: tallies.empty,
      error: tallies.error,
      pending_left: tallies.pendingLeft,
    }),
  );
  return tallies;
}
