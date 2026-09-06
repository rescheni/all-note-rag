import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_SETTINGS,
  normalizeThemeSettings,
  themePatchFrom,
  themeSettingId,
} from "../src/theme-settings.ts";

describe("theme settings", () => {
  it("defaults to matcha", () => {
    expect(normalizeThemeSettings(undefined)).toEqual(DEFAULT_THEME_SETTINGS);
    expect(DEFAULT_THEME_SETTINGS).toEqual({ theme: "matcha" });
  });

  it("keeps known themes and drops junk", () => {
    expect(normalizeThemeSettings({ theme: "ink" })).toEqual({ theme: "ink" });
    expect(normalizeThemeSettings({ theme: "plain" })).toEqual({ theme: "plain" });
    expect(normalizeThemeSettings({ theme: "neon" })).toEqual(DEFAULT_THEME_SETTINGS);
  });

  it("patches only the keys that were sent", () => {
    expect(themePatchFrom({ theme: "ink", nope: 1 })).toEqual({ theme: "ink" });
    expect(themePatchFrom("nope")).toEqual({});
  });

  it("scopes the row per user", () => {
    expect(themeSettingId("u1")).toBe("theme:u1");
  });
});
