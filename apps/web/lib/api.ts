export function apiOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";
}

/**
 * Browser API base.
 * - Localhost: call API :3001 directly (avoids Next rewrite proxy socket hang → HTML error page).
 * - Production: same-origin so Cloudflare/tunnel rewrite still works.
 * Override with NEXT_PUBLIC_BROWSER_API_URL when needed.
 */
export function browserApiBase(): string {
  if (typeof window === "undefined") return "";
  const override = (process.env.NEXT_PUBLIC_BROWSER_API_URL || "").replace(/\/$/, "");
  if (override) return override;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:3001";
  }
  return "";
}

/** Browser: prefer direct local API; else same-origin rewrite. Server: API URL. */
export const API =
  typeof window !== "undefined"
    ? browserApiBase()
    : process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("hub_token");
}

export const ME_CHANGE_EVENT = "hub-me-change";

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("hub_token", token);
  else localStorage.removeItem("hub_token");
}

const HTML_MSG = "服务返回了网页而不是 JSON（常见原因：网关/前端反代超时，或 API 正在重启导致连接被重置）。请稍后重试；若刚部署过，等几秒再问一次。";

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
  if (/aborted|timeout|timed out/i.test(t)) return "请求超时，请稍后重试或缩短问题。";
  if (t.length > 180) return `${t.slice(0, 160)}…`;
  return t;
}

export type ApiInit = RequestInit & {
  /** Client-side abort timeout (ms). Ask uses a longer window so Next HTML error pages are less likely. */
  timeoutMs?: number;
};

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  let signal = rest.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    const ctrl = new AbortController();
    if (rest.signal) {
      if (rest.signal.aborted) ctrl.abort(rest.signal.reason);
      else {
        rest.signal.addEventListener("abort", () => ctrl.abort(rest.signal?.reason), { once: true });
      }
    }
    timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    signal = ctrl.signal;
  }

  let res: Response;
  try {
    res = await fetch(API + path, { ...rest, headers, credentials: "include", signal });
  } catch (e) {
    if (timer) clearTimeout(timer);
    const msg = friendlyErrorMessage(e instanceof Error ? e.message : String(e), "网络错误");
    const err = new Error(msg) as Error & { code?: string };
    err.code = /timeout/i.test(msg) ? "timeout" : "network";
    throw err;
  }
  if (timer) clearTimeout(timer);

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
    const msg = friendlyErrorMessage(
      data?.error?.message,
      html || !res.ok ? (html ? HTML_MSG : res.statusText || "请求失败") : res.statusText,
    );
    const err = new Error(msg) as Error & { code?: string };
    if (data?.error?.code) err.code = data.error.code;
    else if (html) err.code = "bad_response";
    throw err;
  }
  return data as T;
}
