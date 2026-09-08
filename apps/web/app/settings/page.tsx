"use client";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken } from "@/lib/api";
import { AmbientPanel } from "../ambient/ambient-settings";
import { ThemePanel } from "../theme/theme-settings";

type EmbedProvider = "api" | "local";

type AiPublic = {
  configured: boolean;
  base_url: string;
  embedding_model: string;
  chat_model: string;
  embed_provider?: EmbedProvider;
};

type ModelRow = { id: string; owned_by?: string };

type LocalEmbedRow = {
  id: string;
  label: string;
  description: string;
  dim: number;
  sizeHint: string;
  isDefault?: boolean;
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  error?: string;
  bytesOnDisk?: number;
};

const LOCAL_EMBED_HASH = "local-hash-ngram-1536";

function looksEmbed(id: string): boolean {
  const s = id.toLowerCase();
  return /embed|embedding|e5|bge|gte-|text-embedding|nomic-embed|jina-embed/.test(s);
}

function looksChat(id: string): boolean {
  if (looksEmbed(id)) return false;
  const s = id.toLowerCase();
  if (/whisper|tts-|dall-e|moderation|clip|rerank|codec/.test(s)) return false;
  return true;
}

function embedHint(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (!u) return "";
  if (u.includes("openai.com") || u.includes("openai")) {
    return "OpenAI 端点可优先考虑 text-embedding-3-small（软建议，可改）。";
  }
  if (u.includes("deepseek")) {
    return "DeepSeek 端点若提供 embedding 模型，请从列表选择；否则可改用本地模型。";
  }
  if (u.includes("siliconflow") || u.includes("dashscope") || u.includes("aliyun")) {
    return "该网关通常另有 embedding 模型，请刷新列表后挑选带 embed 字样的项。";
  }
  return "嵌入模型请优先选带 embed / embedding / bge / e5 字样的项。";
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function ModelCombo({
  id,
  name,
  label,
  value,
  onChange,
  options,
  placeholder,
  allowCustom = true,
  extraOptions,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ModelRow[];
  placeholder?: string;
  allowCustom?: boolean;
  extraOptions?: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const trimmed = value.trim();
  const needle = trimmed.toLowerCase();
  const exactMatch =
    options.some((m) => m.id === trimmed) ||
    (extraOptions?.some((ex) => ex.id === trimmed) ?? false);
  const filtered = useMemo(() => {
    const active = exactMatch ? "" : needle;
    const base = options.filter((m) => !active || m.id.toLowerCase().includes(active));
    return base.slice(0, 80);
  }, [options, needle, exactMatch]);
  const showCustom = allowCustom && !!trimmed && !exactMatch;
  const showMenu =
    open && (filtered.length > 0 || (extraOptions && extraOptions.length > 0) || showCustom);

  return (
    <div className="field model-combo">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {showMenu ? (
        <div className="model-combo-menu" role="listbox">
          {extraOptions?.map((ex) => (
            <button
              key={ex.id}
              type="button"
              className={`model-combo-item${value === ex.id ? " is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(ex.id);
                setOpen(false);
              }}
            >
              <span>{ex.label}</span>
              <code>{ex.id}</code>
            </button>
          ))}
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`model-combo-item${value === m.id ? " is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span>{m.id}</span>
              {m.owned_by ? <em>{m.owned_by}</em> : null}
            </button>
          ))}
          {showCustom ? (
            <button
              type="button"
              className="model-combo-item is-active"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(value.trim());
                setOpen(false);
              }}
            >
              <span>使用自定义：{value.trim()}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="hint model-combo-hint">可从列表选择，也可直接输入自定义模型名。</p>
    </div>
  );
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<AiPublic | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [embedProvider, setEmbedProvider] = useState<EmbedProvider>("api");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsErr, setModelsErr] = useState("");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [localModels, setLocalModels] = useState<LocalEmbedRow[]>([]);
  const [localDir, setLocalDir] = useState("");
  const [localErr, setLocalErr] = useState("");
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);

  const chatOptions = useMemo(() => models.filter((m) => looksChat(m.id)), [models]);
  const embedOptions = useMemo(() => {
    const embeds = models.filter((m) => looksEmbed(m.id));
    return embeds.length ? embeds : models;
  }, [models]);

  const refreshModels = useCallback(async () => {
    setModelsErr("");
    setModelsBusy(true);
    try {
      const out = await api<{ data: ModelRow[] }>("/v1/settings/ai/models");
      setModels(Array.isArray(out.data) ? out.data : []);
      if (!out.data?.length) setModelsErr("上游未返回可用模型。");
    } catch (e) {
      setModels([]);
      setModelsErr(e instanceof Error ? e.message : "拉取模型列表失败");
    } finally {
      setModelsBusy(false);
    }
  }, []);

  const refreshLocalModels = useCallback(async () => {
    setLocalErr("");
    try {
      const out = await api<{ models: LocalEmbedRow[]; model_dir?: string }>(
        "/v1/settings/ai/local-embed-models",
      );
      setLocalModels(Array.isArray(out.models) ? out.models : []);
      if (out.model_dir) setLocalDir(out.model_dir);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : "加载本地模型目录失败");
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    api<AiPublic>("/v1/settings/ai")
      .then((out) => {
        setCfg(out);
        setChatModel(out.chat_model ?? "");
        setEmbedModel(out.embedding_model ?? "");
        setEmbedProvider(out.embed_provider === "local" ? "local" : "api");
        setBaseUrlDraft(out.base_url ?? "");
        if (out.configured) {
          void (async () => {
            setModelsBusy(true);
            setModelsErr("");
            try {
              const m = await api<{ data: ModelRow[] }>("/v1/settings/ai/models");
              setModels(Array.isArray(m.data) ? m.data : []);
            } catch (e) {
              setModelsErr(e instanceof Error ? e.message : "拉取模型列表失败");
            } finally {
              setModelsBusy(false);
            }
          })();
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
    void refreshLocalModels();
  }, [refreshLocalModels]);

  // Poll while any download is in progress
  useEffect(() => {
    const active = localModels.some((m) => m.downloading) || downloadBusy;
    if (!active) return;
    const t = setInterval(() => {
      void refreshLocalModels();
    }, 1500);
    return () => clearInterval(t);
  }, [localModels, downloadBusy, refreshLocalModels]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setBusy(true);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const apiKey = String(fd.get("api_key") ?? "");
    const body: Record<string, string> = {
      base_url: String(fd.get("base_url") ?? "").trim(),
      embedding_model: embedModel.trim(),
      chat_model: chatModel.trim(),
      embed_provider: embedProvider,
    };
    if (apiKey.trim()) body.api_key = apiKey;
    try {
      const out = await api<AiPublic>("/v1/settings/ai", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setCfg(out);
      setChatModel(out.chat_model ?? "");
      setEmbedModel(out.embedding_model ?? "");
      setEmbedProvider(out.embed_provider === "local" ? "local" : "api");
      setBaseUrlDraft(out.base_url ?? "");
      setOk("已保存。无需重启。");
      const keyInput = form.querySelector('input[name="api_key"]') as HTMLInputElement | null;
      if (keyInput) keyInput.value = "";
      if (out.configured) await refreshModels();
      await refreshLocalModels();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function downloadModel(id: string) {
    setLocalErr("");
    setDownloadBusy(id);
    try {
      await api("/v1/settings/ai/local-embed-models/download", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      await refreshLocalModels();
      setOk(`已下载 ${id}`);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : "下载失败");
      await refreshLocalModels();
    } finally {
      setDownloadBusy(null);
    }
  }

  async function setDefaultLocal(id: string) {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const out = await api<AiPublic>("/v1/settings/ai", {
        method: "PATCH",
        body: JSON.stringify({
          embed_provider: "local",
          embedding_model: id,
        }),
      });
      setCfg(out);
      setEmbedProvider("local");
      setEmbedModel(out.embedding_model ?? id);
      setOk(`已设为默认本地模型：${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "设置默认失败");
    } finally {
      setBusy(false);
    }
  }

  function switchProvider(next: EmbedProvider) {
    setEmbedProvider(next);
    if (next === "local") {
      const currentLocal = localModels.find((m) => m.id === embedModel);
      if (!currentLocal) {
        const def = localModels.find((m) => m.isDefault) ?? localModels[0];
        if (def) setEmbedModel(def.id);
      }
    } else if (embedModel.startsWith("Xenova/")) {
      setEmbedModel("text-embedding-3-small");
    }
  }

  const hint = embedHint(baseUrlDraft || cfg?.base_url || "");

  return (
    <>
      <h1>设置</h1>
      <p className="readonly-banner">
        AI 端点用于<strong>问答</strong>与向量。写作仍在思源 / Notion / 飞书 / Obsidian；中枢只读聚合与问答。
      </p>
      <h2>AI 端点</h2>
      <p className="hint">
        接入 OpenAI 兼容的 Base URL 与 API Key。嵌入可选用<strong>上游 API</strong>或<strong>本地下载的 ONNX
        模型</strong>（@xenova/transformers）。密钥只写不读。
      </p>
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok-msg">{ok}</p>}
      <form className="card form-card" onSubmit={onSubmit}>
        <label htmlFor="base_url">Base URL</label>
        <input
          id="base_url"
          name="base_url"
          type="url"
          placeholder="https://api.openai.com/v1"
          value={baseUrlDraft}
          onChange={(e) => setBaseUrlDraft(e.target.value)}
        />
        <p className="hint">兼容网关也可以，例如自建 vLLM / OneAPI 的 /v1。仅 Chat 也可只填此项。</p>
        <label htmlFor="api_key">API Key</label>
        <input
          id="api_key"
          name="api_key"
          type="password"
          autoComplete="new-password"
          placeholder={cfg?.configured ? "已配置（留空不修改）" : "sk-…"}
        />

        <div className="model-toolbar">
          <button
            type="button"
            className="secondary"
            disabled={modelsBusy || !cfg?.configured}
            onClick={() => void refreshModels()}
            title={cfg?.configured ? "从上游 /models 拉取" : "请先保存 Base URL 与 API Key"}
          >
            {modelsBusy ? "刷新中…" : "刷新模型列表"}
          </button>
          <span className="hint">
            {cfg?.configured
              ? models.length
                ? `已加载 ${models.length} 个模型`
                : "已配置，可刷新列表"
              : "保存端点后可刷新模型列表"}
          </span>
        </div>
        {modelsErr && <p className="err">{modelsErr}</p>}

        <div className="form-grid">
          <ModelCombo
            id="chat_model"
            name="chat_model"
            label="Chat 模型"
            value={chatModel}
            onChange={setChatModel}
            options={chatOptions.length ? chatOptions : models}
            placeholder="gpt-4o-mini"
          />
        </div>

        <h3 className="settings-subhead">嵌入模型</h3>
        <div className="segmented embed-provider-tabs" role="tablist" aria-label="嵌入来源">
          <button
            type="button"
            role="tab"
            aria-selected={embedProvider === "api"}
            className={embedProvider === "api" ? "active" : ""}
            onClick={() => switchProvider("api")}
          >
            上游 API
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={embedProvider === "local"}
            className={embedProvider === "local" ? "active" : ""}
            onClick={() => switchProvider("local")}
          >
            本地模型
          </button>
        </div>

        {embedProvider === "api" ? (
          <div className="embed-api-panel">
            <ModelCombo
              id="embedding_model"
              name="embedding_model"
              label="Embedding 模型"
              value={embedModel}
              onChange={setEmbedModel}
              options={embedOptions}
              placeholder="text-embedding-3-small"
              extraOptions={[
                {
                  id: LOCAL_EMBED_HASH,
                  label: "本地哈希（弱，仅兜底）",
                },
              ]}
            />
            {hint ? <p className="hint">{hint}</p> : null}
          </div>
        ) : (
          <div className="embed-local-panel">
            <p className="hint">
              模型下载到本机目录（Docker 可挂载）：
              <code>{localDir || "data/models"}</code>
              。向量列仍为 1536 维（较小模型会零填充）。
              <strong>更换本地模型后需重新同步以重建向量。</strong>
            </p>
            {localErr && <p className="err">{localErr}</p>}
            <div className="local-embed-list">
              {localModels.map((m) => {
                const isDefault =
                  embedProvider === "local" && embedModel === m.id;
                const busyDl = downloadBusy === m.id || m.downloading;
                return (
                  <div
                    key={m.id}
                    className={`local-embed-card${isDefault ? " is-default" : ""}${
                      m.downloaded ? " is-ready" : ""
                    }`}
                  >
                    <div className="local-embed-main">
                      <div className="local-embed-title">
                        <strong>{m.label}</strong>
                        {m.isDefault ? <span className="pill">推荐</span> : null}
                        {isDefault ? <span className="pill pill-accent">当前默认</span> : null}
                      </div>
                      <code className="local-embed-id">{m.id}</code>
                      <p className="hint">{m.description}</p>
                      <p className="hint">
                        维度 {m.dim} · 约 {m.sizeHint}
                        {m.downloaded
                          ? ` · 已下载${formatBytes(m.bytesOnDisk) ? `（${formatBytes(m.bytesOnDisk)}）` : ""}`
                          : " · 未下载"}
                      </p>
                      {busyDl ? (
                        <div className="local-embed-progress" aria-live="polite">
                          <div
                            className="local-embed-progress-bar"
                            style={{ width: `${Math.max(4, m.progress || 5)}%` }}
                          />
                          <span>下载中… {m.progress || 0}%</span>
                        </div>
                      ) : null}
                      {m.error ? <p className="err">{m.error}</p> : null}
                    </div>
                    <div className="local-embed-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyDl || m.downloaded}
                        onClick={() => void downloadModel(m.id)}
                      >
                        {m.downloaded ? "已下载" : busyDl ? "下载中…" : "下载"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !m.downloaded || isDefault}
                        onClick={() => void setDefaultLocal(m.id)}
                        title={
                          m.downloaded
                            ? "设为默认并切换到本地嵌入"
                            : "请先下载模型"
                        }
                      >
                        {isDefault ? "默认" : "设为默认"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="model-toolbar">
              <button type="button" className="secondary" onClick={() => void refreshLocalModels()}>
                刷新本地下载状态
              </button>
            </div>
          </div>
        )}

        <div className="form-actions">
          <button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
      <ThemePanel />
      <AmbientPanel />
    </>
  );
}
