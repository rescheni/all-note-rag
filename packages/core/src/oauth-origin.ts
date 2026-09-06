/** Page origins allowed as Feishu/Notion OAuth redirect bases. */
export const OAUTH_REDIRECT_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://notes.rei0.cn",
] as const;

const ALLOWED = new Set<string>(OAUTH_REDIRECT_ORIGINS);

/** Parse a page origin; reject paths, credentials, and non-http(s). */
export function normalizeOAuthOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.search || u.hash) return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function isAllowedOAuthOrigin(raw: string): boolean {
  const origin = normalizeOAuthOrigin(raw);
  return origin !== null && ALLOWED.has(origin);
}

/**
 * Resolve the OAuth page origin.
 * Missing/blank → fallback (WEB_ORIGIN) after normalize.
 * Present → must be on the allowlist.
 */
export function resolveOAuthRedirectOrigin(
  requested: string | undefined | null,
  fallback: string,
): { ok: true; origin: string } | { ok: false } {
  if (requested == null || requested.trim() === "") {
    const fromFallback = normalizeOAuthOrigin(fallback) ?? originOfUrl(fallback);
    if (!fromFallback) return { ok: false };
    return { ok: true, origin: fromFallback };
  }
  const origin = normalizeOAuthOrigin(requested);
  if (!origin || !ALLOWED.has(origin)) return { ok: false };
  return { ok: true, origin };
}

export function oauthCallbackRedirectUri(origin: string, provider: "feishu" | "notion" = "feishu"): string {
  return `${origin.replace(/\/$/, "")}/v1/connections/oauth/${provider}/callback`;
}

function originOfUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
