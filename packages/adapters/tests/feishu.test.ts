import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@note-hub/core";
import { FeishuAdapter } from "../src/feishu.ts";

function ctx(): AdapterContext {
  return {
    connection: {
      id: "c1",
      space_id: "s1",
      source: "feishu",
      name: "f",
      config: { wiki_space_id: "spc", obj_types: ["docx"] },
      secrets_ref: "x",
      cursor: null,
      mode: null,
      status: "active",
      last_sync_at: null,
      last_error: null,
    },
    secrets: { app_id: "cli_x", app_secret: "secret-app" },
    cursor: null,
  };
}

describe("feishu adapter", () => {
  it("probe 200 vs 401 and lists nothing", async () => {
    const fetch200: typeof fetch = async (input, init) => {
      expect(String(input)).toContain("tenant_access_token/internal");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.app_id).toBe("cli_x");
      expect(body.app_secret).toBe("secret-app");
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-xxx" }), { status: 200 });
    };
    const adapter = new FeishuAdapter(fetch200);
    const ok = await adapter.probe(ctx());
    expect(ok.ok).toBe(true);
    expect((await adapter.listChanges(ctx())).changes).toEqual([]);
    expect(await adapter.fetchNote(ctx(), "obj")).toBeNull();

    const fetch401: typeof fetch = async () => new Response("no", { status: 401 });
    const bad = await new FeishuAdapter(fetch401).probe(ctx());
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-app");
  });
});
