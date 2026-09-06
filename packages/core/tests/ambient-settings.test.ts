import { describe, expect, it } from "vitest";
import {
  DEFAULT_AMBIENT_SETTINGS,
  ambientPatchFrom,
  ambientSettingId,
  normalizeAmbientSettings,
} from "../src/ambient-settings.ts";

describe("ambient settings", () => {
  it("defaults to on, auto season, faintest density", () => {
    expect(normalizeAmbientSettings(undefined)).toEqual(DEFAULT_AMBIENT_SETTINGS);
    expect(DEFAULT_AMBIENT_SETTINGS).toEqual({ enabled: true, season: "auto", intensity: "faint" });
  });

  it("keeps known values and drops junk", () => {
    expect(normalizeAmbientSettings({ enabled: false, season: "autumn", intensity: "soft" })).toEqual({
      enabled: false,
      season: "autumn",
      intensity: "soft",
    });
    expect(normalizeAmbientSettings({ season: "monsoon", intensity: "storm" })).toEqual(
      DEFAULT_AMBIENT_SETTINGS,
    );
  });

  it("patches only the keys that were sent", () => {
    expect(ambientPatchFrom({ enabled: false, nope: 1 })).toEqual({ enabled: false });
    expect(ambientPatchFrom({ season: "winter" })).toEqual({ season: "winter" });
    expect(ambientPatchFrom("nope")).toEqual({});
  });

  it("scopes the row per user", () => {
    expect(ambientSettingId("u1")).toBe("ambient:u1");
  });
});
