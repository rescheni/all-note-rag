import {
  DEFAULT_OBSIDIAN_IGNORE,
  SOURCE_KINDS,
  type ConnectionConfig,
  type ConnectionSecrets,
  type ConnectionStatus,
  type SourceKind,
} from "./types.ts";

export type ConnectionInput = {
  source?: string;
  name?: string;
  mode?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

export type ValidatedConnection = {
  source: SourceKind;
  name: string;
  config: ConnectionConfig;
  mode: string | null;
  secrets: ConnectionSecrets;
  status: ConnectionStatus;
};

export type ValidateResult =
  | { ok: true; value: ValidatedConnection }
  | { ok: false; code: string; message: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1";
}

function asStringArray(v: unknown): string[] | undefined {
  if (v == null || v === "") return undefined;
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function pickSecrets(raw: Record<string, unknown> | undefined): ConnectionSecrets {
  const s: ConnectionSecrets = {};
  if (!raw) return s;
  const access_key = asString(raw.access_key);
  const secret_key = asString(raw.secret_key);
  const token = asString(raw.token);
  const access_token = asString(raw.access_token);
  const refresh_token = asString(raw.refresh_token);
  const app_id = asString(raw.app_id);
  const app_secret = asString(raw.app_secret);
  const repo_password = asString(raw.repo_password) || asString(raw.repo_key) || asString(raw.passphrase);
  if (access_key) s.access_key = access_key;
  if (secret_key) s.secret_key = secret_key;
  if (token) s.token = token;
  if (access_token) s.access_token = access_token;
  if (refresh_token) s.refresh_token = refresh_token;
  if (app_id) s.app_id = app_id;
  if (app_secret) s.app_secret = app_secret;
  if (repo_password) s.repo_password = repo_password;
  return s;
}

export function secretsHavePayload(s: ConnectionSecrets): boolean {
  return Boolean(
    s.access_key || s.secret_key || s.token || s.access_token || s.refresh_token || s.app_id || s.app_secret || s.repo_password,
  );
}

/** Incoming blank/whitespace secret fields are ignored so an edit form cannot wipe stored keys. */
export function mergeConnectionSecrets(
  existing: ConnectionSecrets | null | undefined,
  incoming: Record<string, unknown> | ConnectionSecrets | undefined,
): ConnectionSecrets {
  const picked = pickSecrets((incoming ?? {}) as Record<string, unknown>);
  return { ...(existing ?? {}), ...picked };
}

/** True when a posix-like prefix has a path segment exactly equal to `repo`. */
export function prefixHasRepoSegment(prefix: string | undefined | null): boolean {
  if (!prefix) return false;
  const cleaned = prefix.replace(/^s3:\/\//i, "");
  return cleaned.split(/[\\/]+/).filter(Boolean).includes("repo");
}

function fail(code: string, message: string): ValidateResult {
  return { ok: false, code, message };
}

export function validateConnectionInput(body: unknown): ValidateResult {
  const input = (body && typeof body === "object" ? body : {}) as ConnectionInput;
  const srcRaw = asString(input.source) || "obsidian";
  if (!(SOURCE_KINDS as readonly string[]).includes(srcRaw)) {
    return fail("invalid_request", `不支持的源: ${srcRaw}`);
  }
  const source = srcRaw as SourceKind;
  const name = asString(input.name);
  const cfgIn = { ...(input.config ?? {}) } as Record<string, unknown>;
  // Never copy secrets into config.
  delete cfgIn.access_key;
  delete cfgIn.secret_key;
  delete cfgIn.token;
  delete cfgIn.access_token;
  delete cfgIn.refresh_token;
  delete cfgIn.app_id;
  delete cfgIn.app_secret;
  delete cfgIn.repo_password;
  delete cfgIn.repo_key;
  delete cfgIn.passphrase;
  const secrets = pickSecrets(input.secrets);

  if (source === "obsidian") {
    if (!name) return fail("invalid_request", "缺少名称");
    const bucket = asString(cfgIn.bucket);
    if (!bucket) return fail("invalid_request", "缺少 bucket");
    const e2ee = asBool(cfgIn.e2ee);
    const ignore = asStringArray(cfgIn.ignore) ?? [...DEFAULT_OBSIDIAN_IGNORE];
    const config: ConnectionConfig = {
      bucket,
      region: asString(cfgIn.region) || "us-east-1",
      remote_prefix: asString(cfgIn.remote_prefix) || "vault1",
      ignore,
      e2ee,
      force_path_style: cfgIn.force_path_style === false ? false : true,
    };
    const endpoint = asString(cfgIn.endpoint);
    if (endpoint) config.endpoint = endpoint;
    return {
      ok: true,
      value: {
        source,
        name,
        config,
        mode: null,
        secrets,
        status: e2ee ? "encrypted_unreadable" : "active",
      },
    };
  }

  if (source === "siyuan") {
    if (!name) return fail("invalid_request", "缺少名称");
    const modeRaw = asString(input.mode) || asString(cfgIn.mode);
    if (modeRaw !== "api" && modeRaw !== "workspace") {
      return fail("invalid_request", "思源 mode 必须是 api 或 workspace");
    }
    const official = asBool(cfgIn.official_s3);
    const workspace_prefix = asString(cfgIn.workspace_prefix);
    const remote_prefix = asString(cfgIn.remote_prefix);
    const config: ConnectionConfig = { mode: modeRaw };
    if (official) config.official_s3 = true;
    if (modeRaw === "api") {
      config.kernel_base_url = asString(cfgIn.kernel_base_url) || "http://127.0.0.1:6806";
      const nbs = asStringArray(cfgIn.notebook_ids);
      if (nbs) config.notebook_ids = nbs;
    } else {
      const bucket = asString(cfgIn.bucket);
      if (!bucket) return fail("invalid_request", "缺少 bucket");
      if (!workspace_prefix) return fail("invalid_request", "缺少 workspace_prefix");
      config.bucket = bucket;
      config.workspace_prefix = workspace_prefix;
      config.region = asString(cfgIn.region) || "us-east-1";
      config.force_path_style = cfgIn.force_path_style === false ? false : true;
      const endpoint = asString(cfgIn.endpoint);
      if (endpoint) config.endpoint = endpoint;
      if (remote_prefix) config.remote_prefix = remote_prefix;
    }
    return {
      ok: true,
      value: {
        source,
        name,
        config,
        mode: modeRaw,
        secrets,
        status: "active",
      },
    };
  }

  if (source === "notion") {
    if (!name) return fail("invalid_request", "缺少名称");
    if (!secrets.token && !secrets.access_token) {
      return fail("invalid_request", "缺少 Notion 授权：请用 Notion 登录或填写 Integration Token");
    }
    const config: ConnectionConfig = {};
    const workspace_id = asString(cfgIn.workspace_id);
    if (workspace_id) config.workspace_id = workspace_id;
    return {
      ok: true,
      value: { source, name, config, mode: null, secrets, status: "active" },
    };
  }

  if (source === "feishu") {
    if (!name) return fail("invalid_request", "缺少名称");
    if (!secrets.app_id || !secrets.app_secret) {
      return fail("invalid_request", "缺少飞书 app_id / app_secret");
    }
    const config: ConnectionConfig = {
      obj_types: asStringArray(cfgIn.obj_types) ?? ["docx"],
    };
    const wiki_space_id = asString(cfgIn.wiki_space_id);
    if (wiki_space_id) config.wiki_space_id = wiki_space_id;
    return {
      ok: true,
      value: { source, name, config, mode: null, secrets, status: "active" },
    };
  }

  return fail("invalid_request", `不支持的源: ${source}`);
}
