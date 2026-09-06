"use client";
import { useEffect } from "react";
import { applyThemeToDocument, type HubTheme } from "./themes";
import { fetchTheme, readCachedTheme, subscribeTheme } from "./store";

/** Chrome / status-bar colors aligned with each healing theme. */
const THEME_COLORS: Record<HubTheme, string> = {
  matcha: "#5e8a68",
  ink: "#7fa88a",
  plain: "#4f7a5a",
};

function syncThemeColorMeta(theme: HubTheme) {
  if (typeof document === "undefined") return;
  const color = THEME_COLORS[theme] ?? THEME_COLORS.matcha;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", color);
}

/**
 * Applies cached theme immediately, then syncs from the server when signed in.
 * Pair with the inline boot script in layout to avoid a flash of the wrong theme.
 */
export function ThemeProvider() {
  useEffect(() => {
    const cached = readCachedTheme();
    applyThemeToDocument(cached.theme);
    syncThemeColorMeta(cached.theme);
    const unsub = subscribeTheme((s) => {
      applyThemeToDocument(s.theme);
      syncThemeColorMeta(s.theme);
    });
    fetchTheme().catch(() => {
      /* signed out or offline: cache stands */
    });
    return unsub;
  }, []);
  return null;
}
