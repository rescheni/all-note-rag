import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HubError, isHubError, SIYUAN_OFFICIAL_S3_CODE, type AdapterContext } from "@note-hub/core";
import { memoryStore, SiYuanAdapter } from "../src/siyuan.ts";

const fixtureRoot = join(fileURLToPath(new URL("../../../fixtures/siyuan-data", import.meta.url)));

function walkFiles(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) Object.assign(out, walkFiles(abs, key));
    else out[key.replaceAll("\\", "/")] = readFileSync(abs, "utf8");
  }
  return out;
}

function ctx(partial: Partial<AdapterContext["connection"]> & { config?: AdapterContext["connection"]["config"] }): AdapterContext {
  return {
    connection: {
      id: "conn_sy",
      space_id: "space_sy",
      source: "siyuan",
      name: "fixture",
      config: partial.config ?? {},
      secrets_ref: null,
      cursor: null,
      mode: partial.mode ?? "workspace",
      status: "active",
      last_sync_at: null,
      last_error: null,
      ...partial,
    },
    secrets: { token: "tok", access_key: "minioadmin", secret_key: "minioadmin" },
    cursor: null,
  };
}

describe("siyuan mode B memoryStore", () => {
  it("lists 2 sy docs and ignores temp + encrypted", async () => {
    const files = walkFiles(fixtureRoot);
    const adapter = new SiYuanAdapter({ store: memoryStore(files) });
    const { changes } = await adapter.listChanges(
      ctx({ mode: "workspace", config: { bucket: "siyuan-src", workspace_prefix: "workspace" } }),
    );
    const ids = changes.map((c) => c.source_id).sort();
    expect(ids).toEqual(["20200813053012-parent0", "20200813054500-nchild0"].sort());
    expect(ids.some((id) => id.includes("encnote"))).toBe(false);
    expect(changes.every((c) => c.type === "upsert")).toBe(true);
  });

  it("official-repo is rejected", async () => {
    const files = walkFiles(fixtureRoot);
    const adapter = new SiYuanAdapter({ store: memoryStore(files) });
    const c = ctx({
      mode: "workspace",
      config: { bucket: "siyuan-src", workspace_prefix: "official-repo" },
    });
    const probe = await adapter.probe(c);
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe(SIYUAN_OFFICIAL_S3_CODE);
    await expect(adapter.listChanges(c)).rejects.toSatisfy((e: unknown) => {
      expect(isHubError(e) || e instanceof HubError).toBe(true);
      expect((e as HubError).code).toBe(SIYUAN_OFFICIAL_S3_CODE);
      return true;
    });
  });
});

describe("siyuan mode A kernel HTTP", () => {
  it("probe 200 vs error", async () => {
    const fetch200: typeof fetch = async (input, init) => {
      const url = String(input);
      expect(url).toContain("/api/notebook/lsNotebooks");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ code: 0, data: { notebooks: [] } }), { status: 200 });
    };
    const ok = await new SiYuanAdapter({ fetch: fetch200 }).probe(
      ctx({ mode: "api", config: { kernel_base_url: "http://127.0.0.1:6806" } }),
    );
    expect(ok.ok).toBe(true);

    const fetchErr: typeof fetch = async () => new Response("nope", { status: 401 });
    const bad = await new SiYuanAdapter({ fetch: fetchErr }).probe(
      ctx({ mode: "api", config: { kernel_base_url: "http://127.0.0.1:6806" } }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe("error");
  });
});
