/** Client-side theme ids — keep in sync with @note-hub/core HUB_THEMES. */

export const HUB_THEMES = ["matcha", "ink", "plain"] as const;
export type HubTheme = (typeof HUB_THEMES)[number];

export type ThemeSettings = { theme: HubTheme };

export const DEFAULT_THEME: ThemeSettings = { theme: "matcha" };

export const THEME_META: Record<
  HubTheme,
  { label: string; note: string; swatch: [string, string, string] }
> = {
  matcha: {
    label: "抹茶纸色",
    note: "暖日宣纸，苔藓缝线。默认，也是中枢的本色。",
    swatch: ["#f3eee4", "#fffaf2", "#5e8a68"],
  },
  ink: {
    label: "墨夜",
    note: "深色阅读：暖墨底、淡纸字，夜里翻笔记不刺眼。",
    swatch: ["#1c1916", "#2a2521", "#7fa88a"],
  },
  plain: {
    label: "素白",
    note: "更安静的浅色：少一点暖黄，字面更干净。",
    swatch: ["#f6f5f2", "#ffffff", "#4f7a5a"],
  },
};

export function normalizeTheme(raw: unknown): ThemeSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme = o.theme;
  if (typeof theme === "string" && (HUB_THEMES as readonly string[]).includes(theme)) {
    return { theme: theme as HubTheme };
  }
  return { ...DEFAULT_THEME };
}

export function applyThemeToDocument(theme: HubTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "matcha") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  root.style.colorScheme = theme === "ink" ? "dark" : "light";
}
