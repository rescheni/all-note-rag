"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";

type AiPublic = {
  configured: boolean;
  base_url: string;
  embedding_model: string;
  chat_model: string;
};

export default function SettingsPage() {
  const [cfg, setCfg] = useState<AiPublic | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    api<AiPublic>("/v1/settings/ai")
      .then(setCfg)
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const apiKey = String(fd.get("api_key") ?? "");
    const body: Record<string, string> = {
      base_url: String(fd.get("base_url") ?? "").trim(),
      embedding_model: String(fd.get("embedding_model") ?? "").trim(),
      chat_model: String(fd.get("chat_model") ?? "").trim(),
    };
    if (apiKey.trim()) body.api_key = apiKey;
    try {
      const out = await api<AiPublic>("/v1/settings/ai", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setCfg(out);
      setOk("已保存。无需重启。");
      const keyInput = e.currentTarget.querySelector('input[name="api_key"]') as HTMLInputElement | null;
      if (keyInput) keyInput.value = "";
    } catch (er) {
      setErr(er instanceof Error ? er.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>AI 端点</h1>
      <p className="readonly-banner">接入 OpenAI 兼容的 Base URL 与 API Key，用于问答与向量。密钥只写不读。</p>
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok-msg">{ok}</p>}
      <form className="card form-card" onSubmit={onSubmit}>
        <label htmlFor="base_url">Base URL</label>
        <input
          id="base_url"
          name="base_url"
          type="url"
          placeholder="https://api.openai.com/v1"
          defaultValue={cfg?.base_url ?? ""}
          key={`u-${cfg?.base_url ?? ""}`}
        />
        <p className="hint">兼容网关也可以，例如自建 vLLM / OneAPI 的 /v1。</p>
        <label htmlFor="api_key">API Key</label>
        <input
          id="api_key"
          name="api_key"
          type="password"
          autoComplete="new-password"
          placeholder={cfg?.configured ? "已配置（留空不修改）" : "sk-…"}
        />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="chat_model">Chat 模型</label>
            <input
              id="chat_model"
              name="chat_model"
              type="text"
              placeholder="gpt-4o-mini"
              defaultValue={cfg?.chat_model ?? ""}
              key={`c-${cfg?.chat_model ?? ""}`}
            />
          </div>
          <div className="field">
            <label htmlFor="embedding_model">Embedding 模型</label>
            <input
              id="embedding_model"
              name="embedding_model"
              type="text"
              placeholder="text-embedding-3-small"
              defaultValue={cfg?.embedding_model ?? ""}
              key={`e-${cfg?.embedding_model ?? ""}`}
            />
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </>
  );
}
