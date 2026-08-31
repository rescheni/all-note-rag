import type { Adapter, AdapterContext, Change, NotePayload, ProbeResult } from "@note-hub/core";

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

export class FeishuAdapter implements Adapter {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    const app_id = ctx.secrets?.app_id;
    const app_secret = ctx.secrets?.app_secret;
    if (!app_id || !app_secret) {
      return { ok: false, status: "error", message: "缺少飞书 app_id / app_secret" };
    }
    try {
      const res = await this.fetchFn(FEISHU_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id, app_secret }),
      });
      if (!res.ok) {
        return { ok: false, status: "error", message: `飞书探活失败 (${res.status})` };
      }
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      if (Number(json.code ?? 0) !== 0) {
        return { ok: false, status: "error", message: String(json.msg ?? json.message ?? "飞书探活失败") };
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
