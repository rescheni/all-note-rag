import { describe, expect, it } from "vitest";
import { TICK_MS, TICK_STALE_MS } from "../src/tick.ts";

describe("TICK_MS", () => {
  it("auto-sync ticks every hour (quiet; manual + S3 wake still immediate)", () => {
    expect(TICK_MS).toBe(3_600_000);
  });

  it("only enqueues connections whose last sync is stale by the same window", () => {
    expect(TICK_STALE_MS).toBe(TICK_MS);
  });
});
