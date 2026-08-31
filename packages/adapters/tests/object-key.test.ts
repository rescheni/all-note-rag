import { describe, expect, it } from "vitest";
import type { ConnectionRecord } from "@note-hub/core";
import {
  connectionOwnsObject,
  mapConnectionObjectKey,
  parseSiyuanWorkspaceRel,
} from "../src/object-key.ts";

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

describe("mapConnectionObjectKey obsidian", () => {
  it("maps vault-relative and full keys without listing", () => {
    const c = conn({});
    const a = mapConnectionObjectKey(c, "vault1/Daily/x.md");
    expect(a?.kind).toBe("note");
    expect(a?.path).toBe("Daily/x.md");
    expect(a?.source_id).toBe("obsidian://conn_test/Daily/x.md");
    const b = mapConnectionObjectKey(c, "Daily/x.md");
    expect(b?.source_id).toBe(a?.source_id);
    expect(mapConnectionObjectKey(c, "vault1/.obsidian/app.json")?.kind).toBe("skip");
    expect(mapConnectionObjectKey(c, "vault1/assets/sample.png")?.kind).toBe("asset");
  });

  it("owns obsidian-src prefix and hub source mirrors", () => {
    const c = conn({});
    expect(connectionOwnsObject(c, "obsidian-src", "vault1/Daily/x.md")?.rel).toBe("Daily/x.md");
    expect(connectionOwnsObject(c, "other", "vault1/Daily/x.md")).toBeNull();
    const hub = connectionOwnsObject(c, "hub-dev", "source/space_test/conn_test/Daily/x.md", "hub-dev");
    expect(hub?.rel).toBe("Daily/x.md");
    expect(hub?.via).toBe("hub");
  });
});

describe("siyuan workspace keys", () => {
  it("maps .sy filename to doc id and skips temp/", () => {
    const c = conn({
      source: "siyuan",
      mode: "workspace",
      config: { bucket: "siyuan-src", workspace_prefix: "workspace", mode: "workspace" },
    });
    const note = mapConnectionObjectKey(
      c,
      "workspace/data/20200813053000-boxdemo/20200813053012-parent0.sy",
    );
    expect(note?.kind).toBe("note");
    expect(note?.source_id).toBe("20200813053012-parent0");
    expect(note?.boxId).toBe("20200813053000-boxdemo");
    expect(mapConnectionObjectKey(c, "workspace/temp/foo.sy")?.kind).toBe("skip");
    expect(parseSiyuanWorkspaceRel("temp/x.sy")?.kind).toBe("skip");
  });
});
