import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { decryptSecret, encryptSecret, verifyOAuthState } from "@note-hub/core";
import { app } from "../src/app.ts";
import { env } from "../src/env.ts";
import { pool } from "../src/db.ts";
import { redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `feishu-oauth-${suffix}@example.test`;
const password = "secret1";
const ACCESS = `fs-at-${suffix}`;
const REFRESH = `fs-rt-${suffix}`;
const APP_ID = `cli_test_${suffix}`;
const APP_SECRET = `fs-csecret-${suffix}`;

async function parse(res: Response) {
  const text = await res.text();
  const loc = res.headers.get("location");
  const setCookie = res.headers.get("set-cookie") ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body, raw: text, location: loc ?? "", setCookie };
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
  expect(raw).not.toContain(APP_SECRET);
  expect(raw).not.toMatch(/ciphertext/i);
}

describe("feishu oauth", () => {
  let token = "";
  let spaceId = "";
  const origFetch = globalThis.fetch;
  const origId = process.env.FEISHU_APP_ID;
  const origSecret = process.env.FEISHU_APP_SECRET;
  const origRedirect = process.env.FEISHU_REDIRECT_URI;

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "飞" });
    expect(a.status).toBe(201);
    token = a.body.token as string;
    spaceId = (a.body.space as { id: string }).id;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_REDIRECT_URI;
    if (origId !== undefined) process.env.FEISHU_APP_ID = origId;
    if (origSecret !== undefined) process.env.FEISHU_APP_SECRET = origSecret;
    if (origRedirect !== undefined) process.env.FEISHU_REDIRECT_URI = origRedirect;
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await redis.quit();
    await pool.end();
  });

  it("status reports unconfigured without env", async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    const r = await get("/v1/connections/oauth/feishu/status", token);
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
    expect(String(r.body.redirect_uri)).toContain("/v1/connections/oauth/feishu/callback");
  });

  it("authorize without client env returns 400; with env returns url+state", async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    const missing = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("我的飞书")}`,
      token,
    );
    expect(missing.status).toBe(400);
    expect(String((missing.body.error as { code?: string })?.code || JSON.stringify(missing.body))).toContain(
      "oauth_not_configured",
    );
    assertNoSecretLeak(missing.body);

    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    const r = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("扫码连接")}`,
      token,
    );
    expect(r.status).toBe(200);
    const url = String(r.body.url);
    expect(url.startsWith("https://accounts.feishu.cn/open-apis/authen/v1/authorize?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe(APP_ID);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/v1/connections/oauth/feishu/callback");
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("wiki:wiki:readonly");
    expect(scope).toContain("docs:document.content:read");
    expect(scope).toContain("drive:drive:readonly");
    expect(scope).toContain("offline_access");
    const state = parsed.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(8);
    const payload = verifyOAuthState(state, env.hubSecret);
    expect(payload?.sid).toBe(spaceId);
    expect(payload?.name).toBe("扫码连接");
    assertNoSecretLeak(r.body);
    assertNoSecretLeak(url);
    expect(url).not.toContain(APP_SECRET);
  });

  it("qr returns old goto without app secret", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    const r = await get(
      `/v1/connections/oauth/feishu/qr?space_id=${spaceId}&name=${encodeURIComponent("扫码连接")}`,
      token,
    );
    expect(r.status).toBe(200);
    const goto = String(r.body.goto);
    expect(goto.startsWith("https://passport.feishu.cn/suite/passport/oauth/authorize?")).toBe(true);
    expect(r.body.client_id).toBe(APP_ID);
    expect(String(r.body.redirect_uri)).toContain("/v1/connections/oauth/feishu/callback");
    const parsed = new URL(goto);
    expect(parsed.searchParams.get("client_id")).toBe(APP_ID);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/v1/connections/oauth/feishu/callback");
    expect(parsed.searchParams.get("state")).toBe(r.body.state);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("wiki:wiki:readonly");
    expect(scope).toContain("offline_access");
    const payload = verifyOAuthState(String(r.body.state), env.hubSecret);
    expect(payload?.sid).toBe(spaceId);
    expect(JSON.stringify(r.body)).not.toContain(APP_SECRET);
    assertNoSecretLeak(r.body);
    assertNoSecretLeak(goto);
  });

  it("callback rejects tampered state and does not store secrets", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    let tokenHits = 0;
    globalThis.fetch = (async () => {
      tokenHits += 1;
      return new Response(JSON.stringify({ code: 0, access_token: ACCESS }), { status: 200 });
    }) as typeof fetch;

    const before = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM connections WHERE space_id = $1 AND source = 'feishu'",
      [spaceId],
    );
    const r = await get("/v1/connections/oauth/feishu/callback?code=fake-code&state=tampered.payload");
    expect(r.status).toBe(302);
    expect(r.location).toContain("oauth_error=");
    expect(r.location).toContain("source=feishu");
    expect(tokenHits).toBe(0);
    const after = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM connections WHERE space_id = $1 AND source = 'feishu'",
      [spaceId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    assertNoSecretLeak(r.location);
    assertNoSecretLeak(r.raw);
  });

  it("callback encrypts user_access_token and refresh_token", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    const started = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("OAuth 飞书")}`,
      token,
    );
    expect(started.status).toBe(200);
    const authorizeUrl = new URL(String(started.body.url));
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state).toBeTruthy();

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        grant_type?: string;
        code?: string;
        client_id?: string;
      };
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("good-code");
      expect(body.client_id).toBe(APP_ID);
      return new Response(
        JSON.stringify({
          code: 0,
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 7200,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const cb = await get(`/v1/connections/oauth/feishu/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain("/connections/");
    expect(cb.location).toContain("oauth=ok");
    assertNoSecretLeak(cb.location);
    assertNoSecretLeak(cb.raw);

    const connId = (cb.location.match(/\/connections\/([0-9a-f-]{36})/) ?? [])[1];
    expect(connId).toBeTruthy();

    const stored = await pool.query<{ ciphertext: string; name: string }>(
      `SELECT s.ciphertext, c.name
       FROM connections c JOIN secrets s ON s.id::text = c.secrets_ref
       WHERE c.id = $1::uuid`,
      [connId],
    );
    expect(stored.rows[0]).toBeTruthy();
    const secrets = JSON.parse(decryptSecret(stored.rows[0].ciphertext, env.hubSecret)) as Record<string, string>;
    expect(secrets.access_token).toBe(ACCESS);
    expect(secrets.user_access_token).toBe(ACCESS);
    expect(secrets.refresh_token).toBe(REFRESH);
    expect(secrets.app_id).toBe(APP_ID);
    expect(stored.rows[0].name).toBe("OAuth 飞书");

    const flags = await get(`/v1/connections/${connId}`, token);
    expect(flags.status).toBe(200);
    expect(flags.body.secrets.access_token).toBe(true);
    expect(flags.body.secrets.user_access_token).toBe(true);
    expect(flags.body.secrets.refresh_token).toBe(true);
    expect(flags.body.secrets.app_id).toBe(true);
    assertNoSecretLeak(flags.body);
  });

  it("authorize uses saved connection app_id without env", async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    const blob = encryptSecret(JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }), env.hubSecret);
    const sec = await pool.query<{ id: string }>("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, secrets_ref, status)
       VALUES ($1, 'feishu', '已有飞书', '{}'::jsonb, $2, 'active') RETURNING id`,
      [spaceId, sec.rows[0].id],
    );
    const r = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&connection_id=${conn.rows[0].id}`,
      token,
    );
    expect(r.status).toBe(200);
    const parsed = new URL(String(r.body.url));
    expect(parsed.searchParams.get("client_id")).toBe(APP_ID);
    expect(String(r.body.url)).not.toContain(APP_SECRET);
    assertNoSecretLeak(r.body);
  });

  it("rejects evil origin and accepts notes.rei0.cn and 127.0.0.1", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;

    const evil = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&origin=${encodeURIComponent("https://evil.example")}`,
      token,
    );
    expect(evil.status).toBe(400);
    expect(String((evil.body.error as { code?: string })?.code || JSON.stringify(evil.body))).toContain(
      "invalid_request",
    );
    assertNoSecretLeak(evil.body);

    const publicHub = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("公网")}&origin=${encodeURIComponent("https://notes.rei0.cn")}`,
      token,
    );
    expect(publicHub.status).toBe(200);
    const publicUrl = new URL(String(publicHub.body.url));
    expect(publicUrl.searchParams.get("redirect_uri")).toBe(
      "https://notes.rei0.cn/v1/connections/oauth/feishu/callback",
    );
    expect(publicHub.setCookie).toContain("Path=/");
    expect(publicHub.setCookie).toContain("HttpOnly");
    expect(publicHub.setCookie).toContain("SameSite=Lax");
    expect(publicHub.setCookie).toContain("Secure");
    const publicState = verifyOAuthState(publicUrl.searchParams.get("state") ?? "", env.hubSecret);
    expect(publicState?.origin).toBe("https://notes.rei0.cn");
    assertNoSecretLeak(publicHub.body);

    const local = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&origin=${encodeURIComponent("http://127.0.0.1:3000")}`,
      token,
    );
    expect(local.status).toBe(200);
    const localUrl = new URL(String(local.body.url));
    expect(localUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/v1/connections/oauth/feishu/callback",
    );
    expect(local.setCookie).toContain("Path=/");
    expect(local.setCookie).toContain("HttpOnly");
    expect(local.setCookie).toContain("SameSite=Lax");
    expect(local.setCookie).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/);
    const localState = verifyOAuthState(localUrl.searchParams.get("state") ?? "", env.hubSecret);
    expect(localState?.origin).toBe("http://127.0.0.1:3000");

    const qr = await get(
      `/v1/connections/oauth/feishu/qr?space_id=${spaceId}&origin=${encodeURIComponent("https://notes.rei0.cn")}`,
      token,
    );
    expect(qr.status).toBe(200);
    expect(qr.body.redirect_uri).toBe("https://notes.rei0.cn/v1/connections/oauth/feishu/callback");
    const goto = new URL(String(qr.body.goto));
    expect(goto.searchParams.get("redirect_uri")).toBe(
      "https://notes.rei0.cn/v1/connections/oauth/feishu/callback",
    );
  });

  it("callback exchanges token with the signed origin redirect_uri", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    const started = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("隧道飞书")}&origin=${encodeURIComponent("https://notes.rei0.cn")}`,
      token,
    );
    expect(started.status).toBe(200);
    const authorizeUrl = new URL(String(started.body.url));
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state).toBeTruthy();

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        grant_type?: string;
        code?: string;
        redirect_uri?: string;
      };
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("tunnel-code");
      expect(body.redirect_uri).toBe("https://notes.rei0.cn/v1/connections/oauth/feishu/callback");
      return new Response(
        JSON.stringify({
          code: 0,
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 7200,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const cb = await get(`/v1/connections/oauth/feishu/callback?code=tunnel-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.location.startsWith("https://notes.rei0.cn/connections/")).toBe(true);
    expect(cb.location).toContain("oauth=ok");
    expect(cb.setCookie).toContain("Secure");
    assertNoSecretLeak(cb.location);
  });

  it("re-auth on existing connection preserves cursor and merges tokens", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    const cursor = { doxKeep: "42", __meta: { doxKeep: { title: "Keep", path: "Keep", obj_type: "docx" } } };
    const blob = encryptSecret(
      JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET, access_token: "old-at", refresh_token: "old-rt" }),
      env.hubSecret,
    );
    const sec = await pool.query<{ id: string }>("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, secrets_ref, status, cursor, last_sync_at)
       VALUES ($1, 'feishu', '保留游标', '{}'::jsonb, $2, 'error', $3::jsonb, now()) RETURNING id`,
      [spaceId, sec.rows[0].id, JSON.stringify(cursor)],
    );
    const connId = conn.rows[0].id;
    const started = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&connection_id=${connId}&name=${encodeURIComponent("保留游标")}`,
      token,
    );
    expect(started.status).toBe(200);
    const state = new URL(String(started.body.url)).searchParams.get("state") ?? "";
    const NEW_AT = `fs-at-re-${suffix}`;
    const NEW_RT = `fs-rt-re-${suffix}`;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { grant_type?: string };
      expect(body.grant_type).toBe("authorization_code");
      return new Response(
        JSON.stringify({
          code: 0,
          access_token: NEW_AT,
          refresh_token: NEW_RT,
          expires_in: 7200,
          refresh_token_expires_in: 2592000,
          scope: "offline_access wiki:wiki:readonly",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const cb = await get(`/v1/connections/oauth/feishu/callback?code=reauth-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain(`/connections/${connId}`);
    expect(cb.location).toContain("oauth=ok");

    const row = await pool.query<{
      status: string;
      last_error: string | null;
      cursor: Record<string, unknown>;
      ciphertext: string;
      last_sync_at: string | null;
    }>(
      `SELECT c.status, c.last_error, c.cursor, c.last_sync_at, s.ciphertext
       FROM connections c JOIN secrets s ON s.id::text = c.secrets_ref
       WHERE c.id = $1::uuid`,
      [connId],
    );
    expect(row.rows[0].status).toBe("active");
    expect(row.rows[0].last_error).toBeNull();
    expect(row.rows[0].last_sync_at).toBeTruthy();
    expect(row.rows[0].cursor).toEqual(cursor);
    const secrets = JSON.parse(decryptSecret(row.rows[0].ciphertext, env.hubSecret)) as Record<string, string>;
    expect(secrets.access_token).toBe(NEW_AT);
    expect(secrets.refresh_token).toBe(NEW_RT);
    expect(secrets.access_token_expires_at).toBeTruthy();
    expect(secrets.refresh_token_expires_at).toBeTruthy();
    expect(JSON.stringify(row.rows[0])).not.toContain(NEW_AT);
  });

  it("callback without connection_id merges onto the sole feishu connection", async () => {
    process.env.FEISHU_APP_ID = APP_ID;
    process.env.FEISHU_APP_SECRET = APP_SECRET;
    // Wipe other feishu rows in this space so exactly one remains.
    await pool.query(`DELETE FROM connections WHERE space_id = $1 AND source = 'feishu'`, [spaceId]);
    const cursor = { onlyDoc: "7" };
    const blob = encryptSecret(
      JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET, access_token: "sole-old", refresh_token: "sole-rt" }),
      env.hubSecret,
    );
    const sec = await pool.query<{ id: string }>("INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id", [blob]);
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, secrets_ref, status, cursor)
       VALUES ($1, 'feishu', '唯一飞书', '{}'::jsonb, $2, 'error', $3::jsonb) RETURNING id`,
      [spaceId, sec.rows[0].id, JSON.stringify(cursor)],
    );
    const connId = conn.rows[0].id;

    const started = await get(
      `/v1/connections/oauth/feishu/authorize?space_id=${spaceId}&name=${encodeURIComponent("唯一飞书")}`,
      token,
    );
    expect(started.status).toBe(200);
    const state = new URL(String(started.body.url)).searchParams.get("state") ?? "";
    const payload = verifyOAuthState(state, env.hubSecret);
    expect(payload?.cid).toBeFalsy();

    const NEW_AT = `fs-at-sole-${suffix}`;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: 0, access_token: NEW_AT, refresh_token: `fs-rt-sole-${suffix}`, expires_in: 7200 }),
        { status: 200 },
      )) as typeof fetch;

    const cb = await get(`/v1/connections/oauth/feishu/callback?code=sole-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain(`/connections/${connId}`);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connections WHERE space_id = $1 AND source = 'feishu'`,
      [spaceId],
    );
    expect(count.rows[0].n).toBe("1");
    const row = await pool.query<{ cursor: Record<string, unknown>; status: string; ciphertext: string }>(
      `SELECT c.cursor, c.status, s.ciphertext
       FROM connections c JOIN secrets s ON s.id::text = c.secrets_ref WHERE c.id = $1::uuid`,
      [connId],
    );
    expect(row.rows[0].status).toBe("active");
    expect(row.rows[0].cursor).toEqual(cursor);
    const secrets = JSON.parse(decryptSecret(row.rows[0].ciphertext, env.hubSecret)) as Record<string, string>;
    expect(secrets.access_token).toBe(NEW_AT);
  });

});
