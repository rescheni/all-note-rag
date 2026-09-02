import { describe, expect, it } from "vitest";
import type { ConnectionRecord } from "@note-hub/core";
import { isLocalS3Endpoint, notificationHasNotehub, signS3Get, sourceTargetsFromConnections } from "../src/s3-notify.ts";
import { extractJsonObjects } from "../src/json-stream.ts";

function conn(partial: Partial<ConnectionRecord> & { config?: ConnectionRecord["config"] }): ConnectionRecord {
  return {
    id: "c1",
    space_id: "s1",
    source: "obsidian",
    name: "v",
    config: {},
    secrets_ref: null,
    cursor: null,
    mode: null,
    status: "active",
    last_sync_at: null,
    last_error: null,
    ...partial,
  };
}

describe("isLocalS3Endpoint", () => {
  it("treats loopback aliases as local and reschen.cn as remote", () => {
    const local = "http://127.0.0.1:9000";
    expect(isLocalS3Endpoint("http://127.0.0.1:9000", local)).toBe(true);
    expect(isLocalS3Endpoint("http://localhost:9000/", local)).toBe(true);
    expect(isLocalS3Endpoint("http://reschen.cn:9000/", local)).toBe(false);
    expect(isLocalS3Endpoint("http://reschen.cn:9000", local)).toBe(false);
  });
});

describe("sourceTargetsFromConnections", () => {
  it("marks Obsidian local MinIO as local and remote SiYuan as skipped", () => {
    const targets = sourceTargetsFromConnections(
      [
        conn({
          id: "obs",
          source: "obsidian",
          config: { bucket: "obsidian-src", endpoint: "http://127.0.0.1:9000", remote_prefix: "vault1" },
        }),
        conn({
          id: "sy",
          source: "siyuan",
          mode: "workspace",
          config: {
            bucket: "siyuan",
            endpoint: "http://reschen.cn:9000/",
            workspace_prefix: "workspace",
            mode: "workspace",
          },
        }),
      ],
      "http://127.0.0.1:9000",
      ["siyuan-src"],
    );
    const local = targets.filter((t) => t.local).map((t) => t.bucket).sort();
    const remote = targets.filter((t) => !t.local);
    expect(local).toContain("obsidian-src");
    expect(local).toContain("siyuan-src");
    expect(local).not.toContain("hub-dev");
    expect(remote.some((t) => t.bucket === "siyuan" && t.reason?.includes("remote"))).toBe(true);
  });
});

describe("notificationHasNotehub", () => {
  it("detects existing queue arn", () => {
    expect(notificationHasNotehub({ QueueConfigurations: [{ QueueArn: "arn:minio:sqs::_:notehub", Id: "notehub" }] })).toBe(
      true,
    );
    expect(notificationHasNotehub({ QueueConfigurations: [] })).toBe(false);
  });
});

describe("signS3Get", () => {
  it("emits AWS4 authorization without leaking the secret into the header name", () => {
    const u = new URL("http://127.0.0.1:9000/obsidian-src");
    u.searchParams.append("events", "s3:ObjectCreated:*");
    const h = signS3Get(u, "minioadmin", "minioadmin", "us-east-1", new Date("2026-09-01T00:00:00Z"));
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=minioadmin\//);
    expect(JSON.stringify(h)).not.toMatch(/AWS4minioadmin/);
  });
});


describe("extractJsonObjects", () => {
  it("parses concatenated objects without newlines", () => {
    const { objects, rest } = extractJsonObjects('{"a":1}{"b":2}{"c":');
    expect(objects).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"c":');
  });
});
