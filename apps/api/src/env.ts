function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error("missing env " + name);
  return v;
}

export const env = {
  databaseUrl: req("DATABASE_URL", "postgres://notehub:notehub@127.0.0.1:5432/notehub"),
  redisUrl: req("REDIS_URL", "redis://127.0.0.1:6379"),
  s3Endpoint: req("S3_ENDPOINT", "http://127.0.0.1:9000"),
  s3Region: req("S3_REGION", "us-east-1"),
  s3Bucket: req("S3_BUCKET", "hub-dev"),
  s3AccessKey: req("S3_ACCESS_KEY", "minioadmin"),
  s3SecretKey: req("S3_SECRET_KEY", "minioadmin"),
  hubSecret: req("HUB_SECRET", "dev-hub-secret-change-me"),
  apiPort: Number(req("API_PORT", "3001")),
  webOrigin: req("WEB_ORIGIN", "http://127.0.0.1:3000"),
  vaultBucket: req("VAULT_BUCKET", "obsidian-src"),
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
