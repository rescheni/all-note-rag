import { describe, expect, it } from "vitest";
import {
  isAllowedOAuthOrigin,
  oauthCallbackRedirectUri,
  resolveOAuthRedirectOrigin,
} from "../src/oauth-origin.ts";

describe("oauth redirect origin allowlist", () => {
  it("accepts notes.rei0.cn and 127.0.0.1", () => {
    expect(isAllowedOAuthOrigin("https://notes.rei0.cn")).toBe(true);
    expect(isAllowedOAuthOrigin("https://notes.rei0.cn/")).toBe(true);
    expect(isAllowedOAuthOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedOAuthOrigin("http://localhost:3000")).toBe(true);
  });

  it("rejects evil origins", () => {
    expect(isAllowedOAuthOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOAuthOrigin("https://notes.rei0.cn.evil.com")).toBe(false);
    expect(isAllowedOAuthOrigin("http://notes.rei0.cn")).toBe(false);
    expect(isAllowedOAuthOrigin("https://notes.rei0.cn/phish")).toBe(false);
    expect(isAllowedOAuthOrigin("javascript:alert(1)")).toBe(false);
    expect(resolveOAuthRedirectOrigin("https://evil.example", "http://127.0.0.1:3000")).toEqual({ ok: false });
  });

  it("builds callback URI from allowed origin and falls back when origin is omitted", () => {
    const publicOrigin = resolveOAuthRedirectOrigin("https://notes.rei0.cn", "http://127.0.0.1:3000");
    expect(publicOrigin).toEqual({ ok: true, origin: "https://notes.rei0.cn" });
    if (!publicOrigin.ok) throw new Error("expected ok");
    expect(oauthCallbackRedirectUri(publicOrigin.origin)).toBe(
      "https://notes.rei0.cn/v1/connections/oauth/feishu/callback",
    );

    const local = resolveOAuthRedirectOrigin("http://127.0.0.1:3000", "https://notes.rei0.cn");
    expect(local).toEqual({ ok: true, origin: "http://127.0.0.1:3000" });

    const missing = resolveOAuthRedirectOrigin("", "http://127.0.0.1:3000");
    expect(missing).toEqual({ ok: true, origin: "http://127.0.0.1:3000" });
  });
});
