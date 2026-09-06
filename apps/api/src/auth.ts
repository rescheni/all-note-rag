import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, Next } from "hono";
import { env } from "./env.ts";
import { errors } from "./errors.ts";
import { query } from "./db.ts";

const scrypt = promisify(scryptCb);

export type AuthUser = {
  id: string;
  email: string;
  display_name: string | null;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$${b64url(salt)}$${b64url(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, "base64url");
  const key = Buffer.from(keyB64, "base64url");
  const derived = (await scrypt(password, salt, key.length)) as Buffer;
  if (derived.length !== key.length) return false;
  return timingSafeEqual(derived, key);
}

export function signToken(userId: string, ttlSec = 60 * 60 * 24 * 7): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac("sha256", env.hubSecret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

export function verifyToken(token: string): { sub: string } | null {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  const payload = Buffer.from(p, "base64url");
  const sig = Buffer.from(s, "base64url");
  const expect = createHmac("sha256", env.hubSecret).update(payload).digest();
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return null;
  try {
    const json = JSON.parse(payload.toString("utf8")) as { sub: string; exp: number };
    if (!json.sub || json.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: json.sub };
  } catch {
    return null;
  }
}

/** Durable API token: hub_ + 32 random bytes base64url. */
export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const token = `hub_${b64url(randomBytes(32))}`;
  return {
    token,
    prefix: token.slice(0, 8),
    hash: hashApiToken(token),
  };
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readBearer(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

function readCookieOrQueryToken(c: Context): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = /(?:^|;\s*)hub_session=([^;]+)/.exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  // Alternative for <img> on GET /assets. Never log this value.
  const q = c.req.query("token");
  return q?.trim() || null;
}

function parseBasicAuth(c: Context): { email: string; password: string } | null {
  const auth = c.req.header("authorization");
  if (!auth?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    const email = decoded.slice(0, i).trim().toLowerCase();
    const password = decoded.slice(i + 1);
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

async function loadUser(id: string): Promise<AuthUser | null> {
  const r = await query<AuthUser>("SELECT id, email, display_name FROM users WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

async function resolveApiToken(token: string): Promise<AuthUser | null> {
  const hash = hashApiToken(token);
  const r = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM api_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Fire-and-forget last_used bump
  void query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => undefined);
  return loadUser(row.user_id);
}

async function resolveBasic(c: Context): Promise<AuthUser | null> {
  const creds = parseBasicAuth(c);
  if (!creds) return null;
  const r = await query<{ id: string; email: string; display_name: string | null; password_hash: string }>(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
    [creds.email],
  );
  const row = r.rows[0];
  if (!row || !(await verifyPassword(creds.password, row.password_hash))) return null;
  return { id: row.id, email: row.email, display_name: row.display_name };
}

export async function requireUser(c: Context, next: Next) {
  const bearer = readBearer(c);
  if (bearer) {
    if (bearer.startsWith("hub_")) {
      const user = await resolveApiToken(bearer);
      if (!user) return errors.unauthenticated(c);
      c.set("user", user);
      await next();
      return;
    }
    const payload = verifyToken(bearer);
    if (!payload) return errors.unauthenticated(c);
    const user = await loadUser(payload.sub);
    if (!user) return errors.unauthenticated(c);
    c.set("user", user);
    await next();
    return;
  }

  // HTTP Basic for agents that only have email/password
  if (c.req.header("authorization")?.toLowerCase().startsWith("basic ")) {
    const user = await resolveBasic(c);
    if (!user) return errors.unauthenticated(c);
    c.set("user", user);
    await next();
    return;
  }

  const token = readCookieOrQueryToken(c);
  if (!token) return errors.unauthenticated(c);
  if (token.startsWith("hub_")) {
    const user = await resolveApiToken(token);
    if (!user) return errors.unauthenticated(c);
    c.set("user", user);
    await next();
    return;
  }
  const payload = verifyToken(token);
  if (!payload) return errors.unauthenticated(c);
  const user = await loadUser(payload.sub);
  if (!user) return errors.unauthenticated(c);
  c.set("user", user);
  await next();
}

function requestIsHttps(c: Context): boolean {
  const xf = (c.req.header("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (xf === "https") return true;
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {
    /* ignore */
  }
  const origin = c.req.header("origin") ?? "";
  if (origin.toLowerCase().startsWith("https://")) return true;
  const referer = c.req.header("referer") ?? "";
  return referer.toLowerCase().startsWith("https://");
}

function sessionCookieFlags(c: Context, maxAge: number): string {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (requestIsHttps(c)) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(c: Context, token: string) {
  c.header("Set-Cookie", `hub_session=${encodeURIComponent(token)}; ${sessionCookieFlags(c, 60 * 60 * 24 * 7)}`);
}

export function clearSessionCookie(c: Context) {
  c.header("Set-Cookie", `hub_session=; ${sessionCookieFlags(c, 0)}`);
}

export type SpaceRole = "owner" | "editor" | "viewer";
export type Membership = { space_id: string; role: SpaceRole };

const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function isSpaceRole(value: string): value is SpaceRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

/** Check a (possibly missing) membership against the minimum role. */
export function checkRole(mem: Membership | null | undefined, min: SpaceRole): "ok" | "not_found" | "forbidden" {
  if (!mem) return "not_found";
  if (ROLE_RANK[mem.role] < ROLE_RANK[min]) return "forbidden";
  return "ok";
}

export async function loadMembership(userId: string, spaceId: string): Promise<Membership | null> {
  const r = await query<Membership>(
    "SELECT space_id, role FROM space_members WHERE user_id = $1 AND space_id = $2",
    [userId, spaceId],
  );
  return r.rows[0] ?? null;
}

export type RoleGate =
  | { ok: true; mem: Membership }
  | { ok: false; error: "not_found" | "forbidden" };

/** Load membership and enforce a minimum role. Non-members are not_found (no leak). */
export async function requireRole(userId: string, spaceId: string, min: SpaceRole): Promise<RoleGate> {
  const mem = await loadMembership(userId, spaceId);
  const status = checkRole(mem, min);
  if (status !== "ok") return { ok: false, error: status };
  return { ok: true, mem: mem! };
}

export function roleDenied(c: Context, gate: RoleGate) {
  if (gate.ok) return null;
  return gate.error === "not_found" ? errors.notFound(c) : errors.forbidden(c);
}
