import "./load-env.ts";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = join(root, "fixtures/obsidian-vault");

const s3 = new S3Client({
  region: env.s3Region,
  endpoint: env.s3Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
});

async function ensure(bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log("created bucket", bucket);
  }
}

async function put(bucket: string, key: string, body: Buffer | string, contentType?: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  console.log("put", bucket, key);
}

async function main() {
  await ensure(env.s3Bucket);
  await ensure(env.vaultBucket);
  const files: Array<[string, string]> = [
    ["Welcome.md", "text/markdown; charset=utf-8"],
    ["Daily/2026-08-29.md", "text/markdown; charset=utf-8"],
    ["assets/sample.png", "image/png"],
    [".obsidian/app.json", "application/json"],
    [".trash/deleted.md", "text/markdown; charset=utf-8"],
  ];
  for (const [rel, ct] of files) {
    const fp = join(fixture, rel);
    if (!existsSync(fp)) throw new Error("missing fixture " + rel);
    await put(env.vaultBucket, `vault1/${rel}`, readFileSync(fp), ct);
  }
  const siyuanRoot = join(root, "fixtures/siyuan-data");
  const siyuanBucket = "siyuan-src";
  await ensure(siyuanBucket);
  function walk(dir: string, prefix = ""): Array<{ key: string; abs: string }> {
    const out: Array<{ key: string; abs: string }> = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const key = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) out.push(...walk(abs, key));
      else out.push({ key: key.replace(/\\/g, "/"), abs });
    }
    return out;
  }
  const guess = (rel: string) => {
    if (rel.endsWith(".sy") || rel.endsWith(".json")) return "application/json";
    if (rel.endsWith(".md")) return "text/markdown; charset=utf-8";
    if (rel.endsWith(".txt")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
  };
  for (const f of walk(siyuanRoot)) {
    await put(siyuanBucket, f.key, readFileSync(f.abs), guess(f.key));
  }
  console.log("seed complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
