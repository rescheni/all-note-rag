export type SyncProgress = {
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  chunksDone: number;
};

type CursorFile = { chunks?: unknown };

function asCursorFiles(cursor: Record<string, unknown> | null | undefined): Record<string, CursorFile> | null {
  if (!cursor || typeof cursor !== "object") return null;
  const files = cursor.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  return files as Record<string, CursorFile>;
}

/** Dejavu object-chunk count for one source_id, or null if the cursor has no files map. */
export function chunksFromCursor(cursor: Record<string, unknown> | null | undefined, sourceId: string): number | null {
  const files = asCursorFiles(cursor);
  if (!files) return null;
  const rec = files[sourceId];
  if (!rec || typeof rec !== "object") return null;
  if (!Array.isArray(rec.chunks)) return null;
  return rec.chunks.length;
}

export function fileChunkCount(
  sourceId: string,
  opts: {
    cursor?: Record<string, unknown> | null;
    chunkCount?: number;
    processed?: number;
  },
): number {
  if (typeof opts.chunkCount === "number" && Number.isFinite(opts.chunkCount)) {
    return Math.max(0, Math.trunc(opts.chunkCount));
  }
  const fromCursor = chunksFromCursor(opts.cursor ?? null, sourceId);
  if (fromCursor != null) return fromCursor;
  if (typeof opts.processed === "number" && Number.isFinite(opts.processed)) {
    return Math.max(0, Math.trunc(opts.processed));
  }
  return 0;
}

export function sumChunksTotal(
  sourceIds: string[],
  cursor: Record<string, unknown> | null | undefined,
  chunkCounts?: Record<string, number | undefined>,
): number {
  let total = 0;
  for (const id of sourceIds) {
    total += fileChunkCount(id, { cursor, chunkCount: chunkCounts?.[id] });
  }
  return total;
}

/** Flush at least every 3 files or every 1s, whichever comes first. */
export function shouldFlushProgress(filesSinceFlush: number, lastFlushAt: number, now: number): boolean {
  return filesSinceFlush >= 3 || now - lastFlushAt >= 1000;
}
