const INSECURE_DEFAULT_HUB_SECRET = "dev-hub-secret-change-me";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error("missing env " + name);
  return v;
}

/** 解析布尔型环境变量；空/未设 → fallback */
function boolEnv(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on", "enabled"].includes(v);
}

/** 解析正整数环境变量；非法/未设 → fallback */
function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function warnInsecureHubSecret(secret: string): void {
  if (secret !== INSECURE_DEFAULT_HUB_SECRET) return;
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "HUB_SECRET is the insecure default; set a strong random value before any shared or internet-facing deploy",
    }),
  );
}

export const env = {
  databaseUrl: req("DATABASE_URL", "postgres://notehub:notehub@127.0.0.1:5432/notehub"),
  redisUrl: req("REDIS_URL", "redis://127.0.0.1:6379"),
  s3Endpoint: req("S3_ENDPOINT", "http://127.0.0.1:9000"),
  s3Region: req("S3_REGION", "us-east-1"),
  s3Bucket: req("S3_BUCKET", "hub-dev"),
  s3AccessKey: req("S3_ACCESS_KEY", "minioadmin"),
  s3SecretKey: req("S3_SECRET_KEY", "minioadmin"),
  hubSecret: req("HUB_SECRET", INSECURE_DEFAULT_HUB_SECRET),
  apiPort: Number(req("API_PORT", "3001")),
  webOrigin: req("WEB_ORIGIN", "http://127.0.0.1:3000"),
  vaultBucket: req("VAULT_BUCKET", "obsidian-src"),

  // ── 账号与安全防护 ───────────────────────────────────────────
  /** 是否开放自助注册。false = 仅已有账号可登录（公网部署建议关闭） */
  allowRegistration: boolEnv("ALLOW_REGISTRATION", true),
  /** 登录：窗口期内允许的失败次数，超过即临时锁定 */
  loginMaxAttempts: intEnv("LOGIN_MAX_ATTEMPTS", 5),
  /** 登录：失败计数窗口（分钟） */
  loginWindowMinutes: intEnv("LOGIN_WINDOW_MINUTES", 15),
  /** 登录：触发后锁定时长（分钟） */
  loginLockMinutes: intEnv("LOGIN_LOCK_MINUTES", 15),
  /** 注册：同一 IP 在窗口期内的最大注册数（0 = 不限制） */
  registerMaxPerIp: intEnv("REGISTER_MAX_PER_IP", 5),
  /** 注册：IP 计数窗口（分钟） */
  registerWindowMinutes: intEnv("REGISTER_WINDOW_MINUTES", 60),
  /** 是否信任反向代理的 X-Forwarded-For（反代后部署请保持开启） */
  trustProxy: boolEnv("TRUST_PROXY", true),
};

const DEFAULT_NOTION_REDIRECT = "http://127.0.0.1:3000/v1/connections/oauth/notion/callback";

export const notionOAuthEnv = {
  get clientId() {
    return process.env.NOTION_CLIENT_ID ?? "";
  },
  get clientSecret() {
    return process.env.NOTION_CLIENT_SECRET ?? "";
  },
  get redirectUri() {
    return process.env.NOTION_REDIRECT_URI || DEFAULT_NOTION_REDIRECT;
  },
  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  },
};

const DEFAULT_FEISHU_REDIRECT = "http://127.0.0.1:3000/v1/connections/oauth/feishu/callback";

export const feishuOAuthEnv = {
  get appId() {
    return process.env.FEISHU_APP_ID ?? "";
  },
  get appSecret() {
    return process.env.FEISHU_APP_SECRET ?? "";
  },
  get redirectUri() {
    return process.env.FEISHU_REDIRECT_URI || DEFAULT_FEISHU_REDIRECT;
  },
  get configured() {
    return Boolean(this.appId && this.appSecret);
  },
};

warnInsecureHubSecret(env.hubSecret);
