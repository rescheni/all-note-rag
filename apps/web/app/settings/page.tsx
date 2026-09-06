"use client";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken } from "@/lib/api";
import { AmbientPanel } from "../ambient/ambient-settings";
import { ThemePanel } from "../theme/theme-settings";

type AiPublic = {
  configured: boolean;
  base_url: string;
  embedding_model: string;
  chat_model: string;
};

type ModelRow = { id: string; owned_by?: string };

const LOCAL_EMBED = "local-hash-ngram-1536";

function looksEmbed(id: string): boolean {
  const s = id.toLowerCase();
  return /embed|embedding|e5|bge|gte-|text-embedding|nomic-embed|jina-embed/.test(s);
}

function looksChat(id: string): boolean {
  if (looksEmbed(id)) return false;
  const s = id.toLowerCase();
  // whisper / tts / dall-e / moderation are clearly not chat
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
    return "DeepSeek 端点若提供 embedding 模型，请从列表选择；否则可暂用本地哈希兜底。";
  }
  if (u.includes("siliconflow") || u.includes("dashscope") || u.includes("aliyun")) {
    return "该网关通常另有 embedding 模型，请刷新列表后挑选带 embed 字样的项。";
  }
  return "嵌入模型请优先选带 embed / embedding / bge / e5 字样的项。";
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
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = options.filter((m) => !needle || m.id.toLowerCase().includes(needle));
    return base.slice(0, 80);
  }, [options, q]);

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
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (filtered.length > 0 || (extraOptions && extraOptions.length) || allowCustom) ? (
        <div className="model-combo-menu" role="listbox">
          {options.length > 6 ? (
            <div className="model-combo-filter is-top">
              <input
                type="search"
                placeholder="筛选模型…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
              />
            </div>
          ) : null}
          {extraOptions?.map((ex) => (
            <button
              key={ex.id}
              type="button"
              className={`model-combo-item${value === ex.id ? " is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(ex.id);
                setQ("");
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
                setQ("");
                setOpen(false);
              }}
            >
              <span>{m.id}</span>
              {m.owned_by ? <em>{m.owned_by}</em> : null}
            </button>
          ))}
          {allowCustom && q.trim() && !filtered.some((m) => m.id === q.trim()) ? (
            <button
              type="button"
              className="model-combo-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(q.trim());
                setOpen(false);
              }}
            >
              <span>使用自定义：{q.trim()}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="hint model-combo-hint">
        可从列表选择，也可直接输入自定义模型名。
      </p>
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
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsErr, setModelsErr] = useState("");
  const [modelsBusy, setModelsBusy] = useState(false);

  const chatOptions = useMemo(
    () => models.filter((m) => looksChat(m.id)),
    [models],
  );
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
        setBaseUrlDraft(out.base_url ?? "");
        if (out.configured) {
          // Auto-fetch when already configured
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
      embedding_model: embedModel.trim(),
      chat_model: chatModel.trim(),
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
      setBaseUrlDraft(out.base_url ?? "");
      setOk("已保存。无需重启。");
      const keyInput = e.currentTarget.querySelector('input[name="api_key"]') as HTMLInputElement | null;
      if (keyInput) keyInput.value = "";
      if (out.configured) {
        await refreshModels();
      }
    } catch (er) {
      setErr(er instanceof Error ? er.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const hint = embedHint(baseUrlDraft || cfg?.base_url || "");

  return (
    <>
      <h1>设置</h1>
      <p className="readonly-banner">AI 端点与界面偏好。</p>
      <h2>AI 端点</h2>
      <p className="hint">接入 OpenAI 兼容的 Base URL 与 API Key，用于问答与向量。密钥只写不读。</p>
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
        <p className="hint">兼容网关也可以，例如自建 vLLM / OneAPI 的 /v1。</p>
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
                id: LOCAL_EMBED,
                label: "本地哈希（弱，仅兜底）",
              },
            ]}
          />
        </div>
        {hint ? <p className="hint">{hint}</p> : null}
        <p className="hint">
          本地真正下载嵌入模型（Ollama / HuggingFace 运行时）尚未接入；当前「本地哈希」只是无词级哈希投影兜底，不适合严肃检索。完整本地模型模式留待后续 Ollama 支持。
        </p>
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
