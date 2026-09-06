import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthStatePayload = {
  v: 1;
  uid: string;
  sid: string;
  cid?: string;
  name?: string;
  ws?: string;
  origin?: string;
  n: string;
  exp: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signOAuthState(
  input: { uid: string; sid: string; cid?: string; name?: string; ws?: string; origin?: string },
  hubSecret: string,
  ttlSec = 600,
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload: OAuthStatePayload = {
    v: 1,
    uid: input.uid,
    sid: input.sid,
    n: nonce,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  if (input.cid) payload.cid = input.cid;
  if (input.name) payload.name = input.name;
  if (input.ws) payload.ws = input.ws;
  if (input.origin) payload.origin = input.origin;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = createHmac("sha256", hubSecret).update(body).digest();
  return { state: `${b64url(body)}.${b64url(sig)}`, nonce };
}

export function verifyOAuthState(state: string, hubSecret: string): OAuthStatePayload | null {
  if (!state || typeof state !== "string") return null;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const p = state.slice(0, dot);
  const s = state.slice(dot + 1);
  let body: Buffer;
  let sig: Buffer;
  try {
    body = Buffer.from(p, "base64url");
    sig = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  const expect = createHmac("sha256", hubSecret).update(body).digest();
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return null;
  try {
    const json = JSON.parse(body.toString("utf8")) as OAuthStatePayload;
    if (json.v !== 1 || typeof json.uid !== "string" || typeof json.sid !== "string" || typeof json.n !== "string") {
      return null;
    }
    if (!json.uid || !json.sid || !json.n) return null;
    if (typeof json.exp !== "number" || json.exp < Math.floor(Date.now() / 1000)) return null;
    return json;
  } catch {
    return null;
  }
}
