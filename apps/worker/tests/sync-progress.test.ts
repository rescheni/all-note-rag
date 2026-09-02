import { describe, expect, it } from "vitest";
import {
  chunksFromCursor,
  fileChunkCount,
  shouldFlushProgress,
  sumChunksTotal,
} from "../src/sync-progress.ts";

const cursor = {
  files: {
    a: { id: "fa", path: "a.sy", chunks: ["c1", "c2", "c3"] },
    b: { id: "fb", path: "b.sy", chunks: ["c4"] },
    empty: { id: "fe", path: "e.sy", chunks: [] },
  },
};

describe("sync progress helpers", () => {
  it("reads dejavu chunk ids from nextCursor.files", () => {
    expect(chunksFromCursor(cursor, "a")).toBe(3);
    expect(chunksFromCursor(cursor, "b")).toBe(1);
    expect(chunksFromCursor(cursor, "empty")).toBe(0);
    expect(chunksFromCursor(cursor, "missing")).toBe(null);
    expect(chunksFromCursor({ etags: {} }, "a")).toBe(null);
  });

  it("prefers Change.chunk_count then cursor then processed hub chunks", () => {
    expect(fileChunkCount("a", { cursor, chunkCount: 9, processed: 2 })).toBe(9);
    expect(fileChunkCount("a", { cursor, processed: 2 })).toBe(3);
    expect(fileChunkCount("obs", { processed: 4 })).toBe(4);
    expect(fileChunkCount("obs", {})).toBe(0);
  });

  it("sums chunks_total for upsert source ids", () => {
    expect(sumChunksTotal(["a", "b"], cursor)).toBe(4);
    expect(sumChunksTotal(["a", "b"], cursor, { a: 10 })).toBe(11);
    expect(sumChunksTotal(["x", "y"], { etags: {} })).toBe(0);
  });

  it("flushes every 3 files or every 1s", () => {
    expect(shouldFlushProgress(3, 0, 10)).toBe(true);
    expect(shouldFlushProgress(2, 0, 1000)).toBe(true);
    expect(shouldFlushProgress(2, 0, 999)).toBe(false);
    expect(shouldFlushProgress(1, 5000, 5500)).toBe(false);
  });
});
