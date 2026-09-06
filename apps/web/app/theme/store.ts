"use client";
import { api, getToken } from "@/lib/api";
import {
  DEFAULT_THEME,
  applyThemeToDocument,
  normalizeTheme,
  type HubTheme,
  type ThemeSettings,
} from "./themes";

const CACHE_KEY = "hub_theme";
export const THEME_EVENT = "note-hub:theme";

export function readCachedTheme(): ThemeSettings {
  if (typeof window === "undefined") return { ...DEFAULT_THEME };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? normalizeTheme(JSON.parse(raw)) : { ...DEFAULT_THEME };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

function cache(s: ThemeSettings) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function publishTheme(s: ThemeSettings) {
  cache(s);
  applyThemeToDocument(s.theme);
  window.dispatchEvent(new CustomEvent<ThemeSettings>(THEME_EVENT, { detail: s }));
}

export function subscribeTheme(fn: (s: ThemeSettings) => void): () => void {
  const onEvent = (e: Event) => fn(normalizeTheme((e as CustomEvent<ThemeSettings>).detail));
  const onStorage = (e: StorageEvent) => {
    if (e.key === CACHE_KEY) {
      const next = readCachedTheme();
      applyThemeToDocument(next.theme);
      fn(next);
    }
  };
  window.addEventListener(THEME_EVENT, onEvent as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, onEvent as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

export async function fetchTheme(): Promise<ThemeSettings | null> {
  if (!getToken()) return null;
  const s = normalizeTheme(await api<ThemeSettings>("/v1/settings/theme"));
  cache(s);
  applyThemeToDocument(s.theme);
  return s;
}

export async function saveTheme(theme: HubTheme): Promise<ThemeSettings> {
  const s = normalizeTheme(
    await api<ThemeSettings>("/v1/settings/theme", {
      method: "PATCH",
      body: JSON.stringify({ theme }),
    }),
  );
  publishTheme(s);
  return s;
}
