import { describe, expect, it } from "vitest";
import type { ConnectionRecord } from "@note-hub/core";
import { extractS3Events, matchObjectEvents, uniqueKeys } from "../src/s3-hook.ts";

function conn(partial: Partial<ConnectionRecord> & { config?: ConnectionRecord["config"] }): ConnectionRecord {
  return {
    id: "conn_test",
    space_id: "space_test",
    source: "obsidian",
    name: "fixture",
    config: { bucket: "obsidian-src", remote_prefix: "vault1", ...(partial.config ?? {}) },
    secrets_ref: null,
    cursor: null,
    mode: null,
    status: "active",
    last_sync_at: null,
    last_error: null,
    ...partial,
  };
}

describe("extractS3Events", () => {
  it("parses Records, {bucket,key}, and MinIO Key=bucket/object", () => {
    const recs = extractS3Events({
      Records: [
        {
          eventName: "s3:ObjectCreated:Put",
          s3: { bucket: { name: "obsidian-src" }, object: { key: "vault1/Daily/x.md" } },
        },
      ],
    });
    expect(recs).toEqual([
      { bucket: "obsidian-src", key: "vault1/Daily/x.md", eventName: "s3:ObjectCreated:Put" },
    ]);
    const simple = extractS3Events({ bucket: "obsidian-src", key: "vault1/Daily/x.md" });
    expect(simple[0]?.key).toBe("vault1/Daily/x.md");
    const minio = extractS3Events({
      EventName: "s3:ObjectCreated:Put",
      Key: "obsidian-src/vault1/Daily/x.md",
    });
    expect(minio).toEqual([
      { bucket: "obsidian-src", key: "vault1/Daily/x.md", eventName: "s3:ObjectCreated:Put" },
    ]);
  });
});

describe("matchObjectEvents", () => {
  const obsidian = conn({});
  const siyuan = conn({
    id: "conn_sy",
    source: "siyuan",
    mode: "workspace",
    config: { bucket: "siyuan-src", workspace_prefix: "workspace", mode: "workspace" },
  });

  it("maps source-bucket put to the matching connection", () => {
    const { matched, ignored } = matchObjectEvents(
      [{ bucket: "obsidian-src", key: "vault1/Daily/x.md", eventName: "s3:ObjectCreated:Put" }],
      [obsidian, siyuan],
    );
    expect(matched).toEqual([{ connection_id: "conn_test", keys: ["vault1/Daily/x.md"] }]);
    expect(ignored).toEqual([]);
  });

  it("ignores unrelated buckets, wrong prefix, hub canonical, and .obsidian", () => {
    const events = [
      { bucket: "no-such-bucket", key: "vault1/Daily/x.md" },
      { bucket: "obsidian-src", key: "other-vault/Daily/x.md" },
      { bucket: "hub-dev", key: "canonical/space_test/note/note.md" },
      { bucket: "hub-dev", key: "source/space_test/conn_test/Daily/x.md" },
      { bucket: "obsidian-src", key: "vault1/.obsidian/app.json" },
      { bucket: "obsidian-src", key: "vault1/.trash/deleted.md" },
      { bucket: "siyuan-src", key: "workspace/temp/foo.sy" },
    ];
    const { matched, ignored } = matchObjectEvents(events, [obsidian, siyuan]);
    expect(matched).toEqual([]);
    expect(ignored).toHaveLength(events.length);
  });

  it("maps siyuan workspace .sy and coalesces keys per connection", () => {
    const { matched } = matchObjectEvents(
      [
        { bucket: "siyuan-src", key: "workspace/data/20200813053000-boxdemo/20200813053012-parent0.sy" },
        { bucket: "siyuan-src", key: "workspace/data/20200813053000-boxdemo/20200813053012-parent0.sy" },
        { bucket: "obsidian-src", key: "vault1/Welcome.md" },
      ],
      [obsidian, siyuan],
    );
    const byId = Object.fromEntries(matched.map((m) => [m.connection_id, m.keys]));
    expect(byId.conn_sy).toEqual(["workspace/data/20200813053000-boxdemo/20200813053012-parent0.sy"]);
    expect(byId.conn_test).toEqual(["vault1/Welcome.md"]);
  });
});

describe("uniqueKeys", () => {
  it("decodes and dedupes", () => {
    expect(uniqueKeys(["vault1/a.md", "vault1/a.md", "vault1/b.md"])).toEqual(["vault1/a.md", "vault1/b.md"]);
  });
});
