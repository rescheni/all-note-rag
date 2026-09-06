export function apiOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";
}

/** Browser: same-origin (Next rewrite). Server: local API. */
export const API = typeof window !== "undefined" ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001");

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("hub_token");
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("hub_token", token);
  else localStorage.removeItem("hub_token");
}

const HTML_MSG = "服务返回了网页而不是数据，请稍后重试。";

function looksLikeHtml(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("<") || /^<!DOCTYPE/i.test(t)) return true;
  return /<\/?[a-z][\s\S]{0,80}>/i.test(t.slice(0, 240));
}

/** Never surface raw HTML / JSON parse dumps to the UI. */
export function friendlyErrorMessage(raw: unknown, fallback = "请求失败"): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return fallback;
  if (/unexpected token\s*</i.test(t) || looksLikeHtml(t)) return HTML_MSG;
  if (t.length > 180) return `${t.slice(0, 160)}…`;
  return t;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(API + path, { ...init, headers, credentials: "include" });
  const text = await res.text();
  const trimmed = (text || "").trim();
  const html = Boolean(trimmed) && looksLikeHtml(trimmed);
  let data: { error?: { code?: string; message?: string } } = {};
  if (trimmed && !html) {
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(HTML_MSG) as Error & { code?: string };
      err.code = "bad_response";
      throw err;
    }
  }
  if (!res.ok || html) {
    const msg = friendlyErrorMessage(data?.error?.message, html || !res.ok ? HTML_MSG : res.statusText);
    const err = new Error(msg) as Error & { code?: string };
    if (data?.error?.code) err.code = data.error.code;
    else if (html) err.code = "bad_response";
    throw err;
  }
  return data as T;
}
