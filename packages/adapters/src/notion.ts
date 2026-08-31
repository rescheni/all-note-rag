import type { Adapter, AdapterContext, Change, NotePayload, ProbeResult } from "@note-hub/core";

const NOTION_VERSION = "2022-06-28";

export class NotionAdapter implements Adapter {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const token = ctx.secrets?.token;
    if (!token) return { ok: false, status: "error", message: "缺少 Notion token" };
    try {
      const res = await this.fetchFn("https://api.notion.com/v1/users/me", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      });
      if (!res.ok) {
        return { ok: false, status: "error", message: `Notion 探活失败 (${res.status})` };
      }
      return { ok: true, status: "active" };
    } catch (err) {
      return { ok: false, status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listChanges(
    _ctx: AdapterContext,
  ): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    return { changes: [], nextCursor: {} };
  }

  async fetchNote(_ctx: AdapterContext, _source_id: string): Promise<NotePayload | null> {
    return null;
  }

  async fetchAsset(_ctx: AdapterContext, _ref: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
}
