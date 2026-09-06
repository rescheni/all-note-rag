"use client";
import { api, getToken } from "@/lib/api";
import { DEFAULT_AMBIENT, normalizeAmbient, type AmbientSeason, type AmbientSettings } from "./season";

const CACHE_KEY = "hub_ambient";
export const AMBIENT_EVENT = "note-hub:ambient";
export const AMBIENT_PREVIEW_EVENT = "note-hub:ambient-preview";

export type AmbientPreviewDetail = {
  season?: AmbientSeason;
  /** Force summer rain on/off for the preview; omitted = same dice the idle session rolls. */
  rain?: boolean;
  ms?: number;
};

/** Cached copy so the overlay can start with the right season before the API answers. */
export function readCachedAmbient(): AmbientSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AMBIENT };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? normalizeAmbient(JSON.parse(raw)) : { ...DEFAULT_AMBIENT };
  } catch {
    return { ...DEFAULT_AMBIENT };
  }
}

function cache(s: AmbientSettings) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: the API row is still the source of truth */
  }
}

/** Tell every mounted overlay (this tab) about new settings. */
export function publishAmbient(s: AmbientSettings) {
  cache(s);
  window.dispatchEvent(new CustomEvent<AmbientSettings>(AMBIENT_EVENT, { detail: s }));
}

export function subscribeAmbient(fn: (s: AmbientSettings) => void): () => void {
  const onEvent = (e: Event) => fn(normalizeAmbient((e as CustomEvent<AmbientSettings>).detail));
  const onStorage = (e: StorageEvent) => {
    if (e.key === CACHE_KEY) fn(readCachedAmbient());
  };
  window.addEventListener(AMBIENT_EVENT, onEvent as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AMBIENT_EVENT, onEvent as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Server copy (per user). Returns null when signed out — the cache then stands in. */
export async function fetchAmbient(): Promise<AmbientSettings | null> {
  if (!getToken()) return null;
  const s = normalizeAmbient(await api<AmbientSettings>("/v1/settings/ambient"));
  cache(s);
  return s;
}

export async function saveAmbient(patch: Partial<AmbientSettings>): Promise<AmbientSettings> {
  const s = normalizeAmbient(
    await api<AmbientSettings>("/v1/settings/ambient", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
  publishAmbient(s);
  return s;
}

/** Show the effect right now for a few seconds, without waiting out the idle timer. */
export function previewAmbient(detail: AmbientPreviewDetail) {
  window.dispatchEvent(new CustomEvent<AmbientPreviewDetail>(AMBIENT_PREVIEW_EVENT, { detail }));
}
