import { describe, expect, it } from "vitest";
import { TICK_MS } from "../src/tick.ts";

describe("TICK_MS", () => {
  it("auto-sync ticks every 30 seconds", () => {
    expect(TICK_MS).toBe(30_000);
  });
});
