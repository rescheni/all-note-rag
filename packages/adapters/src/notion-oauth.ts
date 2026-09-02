import type { ConnectionSecrets } from "@note-hub/core";

export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/** Prefer OAuth access_token; fall back to Integration Token. */
export function notionBearerToken(secrets: ConnectionSecrets | null | undefined): string | undefined {
  const oauth = typeof secrets?.access_token === "string" ? secrets.access_token.trim() : "";
  if (oauth) return oauth;
  const token = typeof secrets?.token === "string" ? secrets.token.trim() : "";
  return token || undefined;
}

export function buildNotionAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${NOTION_AUTHORIZE_URL}?${q.toString()}`;
}

export type NotionTokenResult = {
  access_token: string;
  refresh_token?: string;
  workspace_id?: string;
  workspace_name?: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readTokenResult(json: Record<string, unknown>): NotionTokenResult | null {
  const access_token = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!access_token) return null;
  const out: NotionTokenResult = { access_token };
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
  if (refresh) out.refresh_token = refresh;
  const workspace_id = typeof json.workspace_id === "string" ? json.workspace_id.trim() : "";
  if (workspace_id) out.workspace_id = workspace_id;
  const workspace_name = typeof json.workspace_name === "string" ? json.workspace_name.trim() : "";
  if (workspace_name) out.workspace_name = workspace_name;
  return out;
}

async function notionTokenRequest(
  fetchFn: typeof fetch,
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<NotionTokenResult> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const res = await fetchFn(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = asRecord(await res.json());
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new Error(`Notion 换票失败 (${res.status})`);
  }
  const parsed = readTokenResult(json);
  if (!parsed) throw new Error("Notion 换票失败 (无 access_token)");
  return parsed;
}

export async function exchangeNotionAuthorizationCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<NotionTokenResult> {
  return notionTokenRequest(opts.fetchFn ?? fetch, opts.clientId, opts.clientSecret, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

export async function refreshNotionAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}): Promise<NotionTokenResult> {
  return notionTokenRequest(opts.fetchFn ?? fetch, opts.clientId, opts.clientSecret, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
}

/** Merge OAuth tokens into connection secrets. Copies access_token into token so older workers still sync. */
export function applyNotionOAuthSecrets(
  existing: ConnectionSecrets | null | undefined,
  tokens: NotionTokenResult,
): ConnectionSecrets {
  const next: ConnectionSecrets = { ...(existing ?? {}) };
  next.access_token = tokens.access_token;
  next.token = tokens.access_token;
  if (tokens.refresh_token) next.refresh_token = tokens.refresh_token;
  return next;
}
