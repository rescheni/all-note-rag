export const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("hub_token");
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("hub_token", token);
  else localStorage.removeItem("hub_token");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(API + path, { ...init, headers, credentials: "include" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const err = new Error(msg) as Error & { code?: string };
    if (data?.error?.code) err.code = data.error.code;
    throw err;
  }
  return data as T;
}
