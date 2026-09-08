import type { ConnectionSecrets } from "@note-hub/core";

export const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
/** QR SDK goto. Docs: 暂不支持新版登录流程. */
export const FEISHU_QR_AUTHORIZE_URL = "https://passport.feishu.cn/suite/passport/oauth/authorize";
export const FEISHU_OAUTH_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

/** Space-separated user scopes: list+read wiki/docx/drive, plus refresh_token. */
export const FEISHU_OAUTH_SCOPES = [
  "wiki:wiki:readonly",
  "wiki:space:retrieve",
  "wiki:node:retrieve",
  "docs:doc:readonly",
  "docs:document.content:read",
  "docx:document:readonly",
  "drive:drive:readonly",
  "offline_access",
].join(" ");

/** Refresh skew: refresh access_token this many ms before expiry. */
export const FEISHU_ACCESS_SKEW_MS = 120_000;

export function feishuUserAccessToken(secrets: ConnectionSecrets | null | undefined): string | undefined {
  const user = typeof secrets?.user_access_token === "string" ? secrets.user_access_token.trim() : "";
  if (user) return user;
  const access = typeof secrets?.access_token === "string" ? secrets.access_token.trim() : "";
  return access || undefined;
}

export function feishuOAuthClient(secrets?: ConnectionSecrets | null): { clientId: string; clientSecret: string } | null {
  const clientId = (typeof secrets?.app_id === "string" ? secrets.app_id.trim() : "") || (process.env.FEISHU_APP_ID ?? "").trim();
  const clientSecret =
    (typeof secrets?.app_secret === "string" ? secrets.app_secret.trim() : "") || (process.env.FEISHU_APP_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function buildFeishuAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: opts.scope ?? FEISHU_OAUTH_SCOPES,
    state: opts.state,
    prompt: "consent",
  });
  return `${FEISHU_AUTHORIZE_URL}?${q.toString()}`;
}

/** Old authorize URL required by QRLogin({ goto }). redirect_uri is encoded. */
export function buildFeishuQrGotoUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    state: opts.state,
    // Old passport endpoint still accepts scope; without it QR login often lacks wiki/docx.
    scope: opts.scope ?? FEISHU_OAUTH_SCOPES,
  });
  return `${FEISHU_QR_AUTHORIZE_URL}?${q.toString()}`;
}

export type FeishuTokenResult = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
};

export class FeishuTokenError extends Error {
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = "FeishuTokenError";
    this.code = code;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readTokenResult(json: Record<string, unknown>): FeishuTokenResult | null {
  const access_token = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!access_token) return null;
  const out: FeishuTokenResult = { access_token };
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
  if (refresh) out.refresh_token = refresh;
  if (typeof json.expires_in === "number") out.expires_in = json.expires_in;
  if (typeof json.refresh_token_expires_in === "number") out.refresh_token_expires_in = json.refresh_token_expires_in;
  if (typeof json.scope === "string") out.scope = json.scope;
  return out;
}

async function feishuTokenRequest(
  fetchFn: typeof fetch,
  body: Record<string, string>,
): Promise<FeishuTokenResult> {
  const res = await fetchFn(FEISHU_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = asRecord(await res.json());
  } catch {
    json = {};
  }
  const code = Number(json.code ?? (res.ok ? 0 : res.status));
  if (!res.ok || code !== 0) {
    const msg = String(json.msg ?? json.message ?? json.error_description ?? json.error ?? "飞书换票失败");
    throw new FeishuTokenError(`飞书换票失败 (${code || res.status}): ${msg}`, code || res.status);
  }
  const parsed = readTokenResult(json);
  if (!parsed) throw new FeishuTokenError("飞书换票失败 (无 access_token)", code);
  return parsed;
}

export async function exchangeFeishuAuthorizationCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<FeishuTokenResult> {
  return feishuTokenRequest(opts.fetchFn ?? fetch, {
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

export async function refreshFeishuAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}): Promise<FeishuTokenResult> {
  return feishuTokenRequest(opts.fetchFn ?? fetch, {
    grant_type: "refresh_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

function isoAfterSeconds(seconds: number, nowMs = Date.now()): string {
  return new Date(nowMs + Math.max(0, seconds) * 1000).toISOString();
}

/** Merge user OAuth tokens into connection secrets. Keeps app_id / app_secret. */
export function applyFeishuOAuthSecrets(
  existing: ConnectionSecrets | null | undefined,
  tokens: FeishuTokenResult,
  client?: { clientId?: string; clientSecret?: string },
): ConnectionSecrets {
  const next: ConnectionSecrets = { ...(existing ?? {}) };
  next.access_token = tokens.access_token;
  next.user_access_token = tokens.access_token;
  // Feishu refresh_token is single-use: always prefer the rotated value when present.
  if (tokens.refresh_token) next.refresh_token = tokens.refresh_token;
  if (tokens.scope) next.scope = tokens.scope;
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
    next.access_token_expires_at = isoAfterSeconds(tokens.expires_in);
  }
  if (
    tokens.refresh_token &&
    typeof tokens.refresh_token_expires_in === "number" &&
    Number.isFinite(tokens.refresh_token_expires_in)
  ) {
    next.refresh_token_expires_at = isoAfterSeconds(tokens.refresh_token_expires_in);
  }
  if (client?.clientId && !next.app_id) next.app_id = client.clientId;
  if (client?.clientSecret && !next.app_secret) next.app_secret = client.clientSecret;
  return next;
}

/** True when we know access_token is still usable (with skew). Unknown expiry → false. */
export function feishuAccessTokenFresh(
  secrets: ConnectionSecrets | null | undefined,
  skewMs = FEISHU_ACCESS_SKEW_MS,
): boolean {
  if (!feishuUserAccessToken(secrets)) return false;
  const raw = secrets?.access_token_expires_at;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t - skewMs > Date.now();
}

/** True when refresh_token_expires_at is present and already past. */
export function feishuRefreshTokenExpired(secrets: ConnectionSecrets | null | undefined): boolean {
  const raw = secrets?.refresh_token_expires_at;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t <= Date.now();
}

export function feishuRefreshFailureMessage(err: unknown): string {
  const code = err instanceof FeishuTokenError ? err.code : 0;
  // 20037: refresh_token expired; 20026 invalid; 20064 revoked / already used.
  if (code === 20037) {
    return "飞书刷新令牌已过期，请重新扫码登录（已有笔记与增量游标会保留）";
  }
  if (code === 20064 || code === 20073) {
    return "飞书刷新令牌已失效，请重新扫码登录（已有笔记与增量游标会保留）";
  }
  if (code === 20026) {
    return "飞书刷新令牌无效，请重新扫码登录（已有笔记与增量游标会保留）";
  }
  return "用户令牌已过期且无法刷新，请重新扫码（需刷新令牌 / offline_access；已有笔记与增量游标会保留）";
}
