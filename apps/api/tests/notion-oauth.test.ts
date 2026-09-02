import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { decryptSecret, verifyOAuthState } from "@note-hub/core";
import { app } from "../src/app.ts";
import { env } from "../src/env.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `notion-oauth-${suffix}@example.test`;
const password = "secret1";
const ACCESS = `oauth-at-${suffix}`;
const REFRESH = `oauth-rt-${suffix}`;
const CLIENT_ID = `notion-cid-${suffix}`;
const CLIENT_SECRET = `notion-csecret-${suffix}`;

async function parse(res: Response) {
  const text = await res.text();
  const loc = res.headers.get("location");
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body, raw: text, location: loc ?? "" };
}

function headers(token?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...(extra ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function get(path: string, token?: string, extra?: Record<string, string>) {
  return parse(await app.request(path, { headers: headers(token, extra) }));
}

async function post(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

function assertNoSecretLeak(payload: unknown) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  expect(raw).not.toContain(ACCESS);
  expect(raw).not.toContain(REFRESH);
  expect(raw).not.toContain(CLIENT_SECRET);
  expect(raw).not.toMatch(/ciphertext/i);
}

describe("notion oauth", () => {
  let token = "";
  let spaceId = "";
  const origFetch = globalThis.fetch;
  const origId = process.env.NOTION_CLIENT_ID;
  const origSecret = process.env.NOTION_CLIENT_SECRET;
  const origRedirect = process.env.NOTION_REDIRECT_URI;

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "诺" });
    expect(a.status).toBe(201);
    token = a.body.token as string;
    spaceId = (a.body.space as { id: string }).id;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.NOTION_CLIENT_ID;
    delete process.env.NOTION_CLIENT_SECRET;
    delete process.env.NOTION_REDIRECT_URI;
    if (origId !== undefined) process.env.NOTION_CLIENT_ID = origId;
    if (origSecret !== undefined) process.env.NOTION_CLIENT_SECRET = origSecret;
    if (origRedirect !== undefined) process.env.NOTION_REDIRECT_URI = origRedirect;
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await redis.quit();
    await pool.end();
  });

  it("status reports unconfigured without env", async () => {
    delete process.env.NOTION_CLIENT_ID;
    delete process.env.NOTION_CLIENT_SECRET;
    const r = await get("/v1/connections/oauth/notion/status", token);
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
    expect(String(r.body.redirect_uri)).toContain("/v1/connections/oauth/notion/callback");
  });

  it("authorize without client env returns 400; with env returns url+state", async () => {
    delete process.env.NOTION_CLIENT_ID;
    delete process.env.NOTION_CLIENT_SECRET;
    const missing = await get(`/v1/connections/oauth/notion/authorize?space_id=${spaceId}&name=${encodeURIComponent("我的 Notion")}`, token);
    expect(missing.status).toBe(400);
    expect(String((missing.body.error as { code?: string })?.code || JSON.stringify(missing.body))).toContain("oauth_not_configured");
    assertNoSecretLeak(missing.body);

    process.env.NOTION_CLIENT_ID = CLIENT_ID;
    process.env.NOTION_CLIENT_SECRET = CLIENT_SECRET;
    const r = await get(
      `/v1/connections/oauth/notion/authorize?space_id=${spaceId}&name=${encodeURIComponent("测试工作区")}`,
      token,
    );
    expect(r.status).toBe(200);
    const url = String(r.body.url);
    expect(url.startsWith("https://api.notion.com/v1/oauth/authorize?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("owner")).toBe("user");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/v1/connections/oauth/notion/callback");
    const state = parsed.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(8);
    const payload = verifyOAuthState(state, env.hubSecret);
    expect(payload?.sid).toBe(spaceId);
    expect(payload?.name).toBe("测试工作区");
    assertNoSecretLeak(r.body);
    assertNoSecretLeak(url);
  });

  it("callback rejects tampered state and does not store secrets", async () => {
    process.env.NOTION_CLIENT_ID = CLIENT_ID;
    process.env.NOTION_CLIENT_SECRET = CLIENT_SECRET;
    let tokenHits = 0;
    globalThis.fetch = (async () => {
      tokenHits += 1;
      return new Response(JSON.stringify({ access_token: ACCESS }), { status: 200 });
    }) as typeof fetch;

    const before = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM connections WHERE space_id = $1 AND source = 'notion'", [spaceId]);
    const r = await get("/v1/connections/oauth/notion/callback?code=fake-code&state=tampered.payload");
    expect(r.status).toBe(302);
    expect(r.location).toContain("oauth_error=");
    expect(r.location).toContain("source=notion");
    expect(tokenHits).toBe(0);
    const after = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM connections WHERE space_id = $1 AND source = 'notion'", [spaceId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    assertNoSecretLeak(r.location);
    assertNoSecretLeak(r.raw);
  });

  it("callback stores encrypted access_token (and refresh if provided)", async () => {
    process.env.NOTION_CLIENT_ID = CLIENT_ID;
    process.env.NOTION_CLIENT_SECRET = CLIENT_SECRET;
    const started = await get(
      `/v1/connections/oauth/notion/authorize?space_id=${spaceId}&name=${encodeURIComponent("OAuth 连接")}`,
      token,
    );
    expect(started.status).toBe(200);
    const authorizeUrl = new URL(String(started.body.url));
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state).toBeTruthy();

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(url).toBe("https://api.notion.com/v1/oauth/token");
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      expect(auth.startsWith("Basic ")).toBe(true);
      const body = JSON.parse(String(init?.body ?? "{}")) as { grant_type?: string; code?: string };
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("good-code");
      return new Response(
        JSON.stringify({
          access_token: ACCESS,
          refresh_token: REFRESH,
          workspace_id: "ws-from-notion",
          workspace_name: "WS",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const cb = await get(`/v1/connections/oauth/notion/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain("/connections/");
    expect(cb.location).toContain("oauth=ok");
    assertNoSecretLeak(cb.location);
    assertNoSecretLeak(cb.raw);

    const connId = (cb.location.match(/\/connections\/([0-9a-f-]{36})/) ?? [])[1];
    expect(connId).toBeTruthy();

    const stored = await pool.query<{ ciphertext: string; config: Record<string, unknown>; name: string }>(
      `SELECT s.ciphertext, c.config, c.name
       FROM connections c JOIN secrets s ON s.id::text = c.secrets_ref
       WHERE c.id = $1::uuid`,
      [connId],
    );
    expect(stored.rows[0]).toBeTruthy();
    const secrets = JSON.parse(decryptSecret(stored.rows[0].ciphertext, env.hubSecret)) as Record<string, string>;
    expect(secrets.access_token).toBe(ACCESS);
    expect(secrets.refresh_token).toBe(REFRESH);
    expect(secrets.token).toBe(ACCESS);
    expect(stored.rows[0].config.workspace_id).toBe("ws-from-notion");
    expect(stored.rows[0].name).toBe("OAuth 连接");

    const flags = await get(`/v1/connections/${connId}`, token);
    expect(flags.status).toBe(200);
    expect(flags.body.secrets.access_token).toBe(true);
    expect(flags.body.secrets.token).toBe(true);
    expect(flags.body.secrets.refresh_token).toBe(true);
    assertNoSecretLeak(flags.body);
  });

  it("token-only create still works", async () => {
    const r = await post(
      `/v1/spaces/${spaceId}/connections`,
      { source: "notion", name: "Token 连接", secrets: { token: `ntn-${suffix}` } },
      token,
    );
    expect(r.status).toBe(201);
    expect(r.body.connection.secrets_ref).toBe("configured");
    expect(JSON.stringify(r.body)).not.toContain(`ntn-${suffix}`);
  });
});
