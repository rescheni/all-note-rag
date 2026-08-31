import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@note-hub/core";
import { NotionAdapter } from "../src/notion.ts";

function ctx(): AdapterContext {
  return {
    connection: {
      id: "c1",
      space_id: "s1",
      source: "notion",
      name: "n",
      config: { workspace_id: "ws" },
      secrets_ref: "x",
      cursor: null,
      mode: null,
      status: "active",
      last_sync_at: null,
      last_error: null,
    },
    secrets: { token: "secret-token" },
    cursor: null,
  };
}

describe("notion adapter", () => {
  it("probe 200 vs 401 and does not list pages", async () => {
    const fetch200: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.notion.com/v1/users/me");
      expect(init?.method ?? "GET").toBe("GET");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer secret-token");
      expect(h.get("Notion-Version")).toBe("2022-06-28");
      return new Response(JSON.stringify({ object: "user", id: "u1" }), { status: 200 });
    };
    const adapter = new NotionAdapter(fetch200);
    const ok = await adapter.probe(ctx());
    expect(ok.ok).toBe(true);
    const { changes } = await adapter.listChanges(ctx());
    expect(changes).toEqual([]);
    expect(await adapter.fetchNote(ctx(), "page")).toBeNull();

    const fetch401: typeof fetch = async () => new Response("unauthorized", { status: 401 });
    const bad = await new NotionAdapter(fetch401).probe(ctx());
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-token");
  });
});
