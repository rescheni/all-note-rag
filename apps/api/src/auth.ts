import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
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

function readToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = c.req.header("cookie") ?? "";
  const m = /(?:^|;\s*)hub_session=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function requireUser(c: Context, next: Next) {
  const token = readToken(c);
  if (!token) return errors.unauthenticated(c);
  const payload = verifyToken(token);
  if (!payload) return errors.unauthenticated(c);
  const r = await query<AuthUser>(
    "SELECT id, email, display_name FROM users WHERE id = $1",
    [payload.sub],
  );
  const user = r.rows[0];
  if (!user) return errors.unauthenticated(c);
  c.set("user", user);
  await next();
}

export function setSessionCookie(c: Context, token: string) {
  c.header(
    "Set-Cookie",
    `hub_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`,
  );
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
