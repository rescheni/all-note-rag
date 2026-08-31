function req(name: string, fallback?: string): string {
  return process.env[name] ?? fallback ?? "";
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
};
