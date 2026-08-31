import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, beforeAll } from "vitest";
import { ObsidianAdapter } from "../src/obsidian.ts";
import { shouldIgnore, stripPrefix } from "@note-hub/core";
import type { AdapterContext } from "@note-hub/core";

const endpoint = process.env.S3_ENDPOINT || "http://127.0.0.1:9000";
const bucket = "obsidian-src-test";
const fixtureRoot = join(fileURLToPath(new URL("../../../fixtures/obsidian-vault", import.meta.url)));

const client = new S3Client({
  region: "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
});

const ctx: AdapterContext = {
  connection: {
    id: "conn_test",
    space_id: "space_test",
    source: "obsidian",
    name: "fixture",
    config: {
      bucket,
      region: "us-east-1",
      remote_prefix: "vault1",
      endpoint,
      ignore: [".obsidian/", ".trash/"],
      e2ee: false,
      force_path_style: true,
    },
    secrets_ref: null,
    cursor: null,
    mode: null,
    status: "active",
    last_sync_at: null,
    last_error: null,
  },
  secrets: { access_key: "minioadmin", secret_key: "minioadmin" },
  cursor: null,
};

describe("obsidian ignore rules", () => {
  it("fixture paths: ignore config dirs, keep 2 md + png", () => {
    const rels = [
      "Welcome.md",
      "Daily/2026-08-29.md",
      "assets/sample.png",
      ".obsidian/app.json",
      ".trash/deleted.md",
    ];
    const kept = rels.filter((r) => !shouldIgnore(stripPrefix("vault1/" + r, "vault1")));
    expect(kept).toEqual(["Welcome.md", "Daily/2026-08-29.md", "assets/sample.png"]);
  });
});

describe("obsidian adapter against MinIO fixture", () => {
  beforeAll(async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    const files = [
      ["Welcome.md", "text/markdown"],
      ["Daily/2026-08-29.md", "text/markdown"],
      ["assets/sample.png", "image/png"],
      [".obsidian/app.json", "application/json"],
      [".trash/deleted.md", "text/markdown"],
    ] as const;
    for (const [rel, ct] of files) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `vault1/${rel}`,
          Body: readFileSync(join(fixtureRoot, rel)),
          ContentType: ct,
        }),
      );
    }
  });

  it("listChanges returns 2 md + referenced png, not ignored files", async () => {
    const adapter = new ObsidianAdapter(client);
    const { changes } = await adapter.listChanges(ctx);
    const paths = changes.map((c) => c.path).sort();
    expect(paths).toEqual(["Daily/2026-08-29.md", "Welcome.md", "assets/sample.png"].sort());
    expect(paths.some((p) => p?.includes(".obsidian"))).toBe(false);
    expect(paths.some((p) => p?.includes(".trash"))).toBe(false);
  });
});
