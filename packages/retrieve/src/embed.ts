import { toFtsTokens } from "@note-hub/core";
import {
  DEFAULT_LOCAL_EMBED_MODEL,
  embedTextsLocal,
  isLocalCatalogModel,
} from "./local-embed.ts";

export const EMBEDDING_DIM = 1536;
export const LOCAL_EMBEDDING_MODEL = "local-hash-ngram-1536";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export type EmbedProvider = "api" | "local";

export type EmbedEndpoint = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** api = OpenAI-compatible /embeddings; local = ONNX via @xenova/transformers */
  provider?: EmbedProvider;
};

export function embeddingModelId(opts?: EmbedEndpoint): string {
  const provider = resolveProvider(opts);
  if (provider === "local") {
    return opts?.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || DEFAULT_LOCAL_EMBED_MODEL;
  }
  const base = opts?.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim();
  const key = opts?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (base && key) {
    return opts?.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  }
  return LOCAL_EMBEDDING_MODEL;
}

function resolveProvider(opts?: EmbedEndpoint): EmbedProvider {
  if (opts?.provider === "local" || opts?.provider === "api") return opts.provider;
  const envP = process.env.EMBED_PROVIDER?.trim().toLowerCase();
  if (envP === "local" || envP === "api") return envP;
  const model = opts?.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || "";
  if (isLocalCatalogModel(model) && model !== LOCAL_EMBEDDING_MODEL) return "local";
  return "api";
}

function fnv1a32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let s = 0;
  for (const x of vec) s += x * x;
  const n = Math.sqrt(s);
  if (n < 1e-12) return vec;
  return vec.map((x) => x / n);
}

/** Stable hashed n-gram projector: CJK bigrams + latin words → 1536-d L2 unit vector. */
export function localProject(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIM);
  const tokens = toFtsTokens(text).split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const h = fnv1a32(tok);
    const idx = h % EMBEDDING_DIM;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    vec[idx] += sign;
  }
  return l2normalize(Array.from(vec));
}

export function averageVectors(vecs: number[][]): number[] {
  const usable = vecs.filter((v) => v.length > 0);
  if (!usable.length) return [];
  const dim = usable[0]!.length;
  const acc = new Array(dim).fill(0);
  let n = 0;
  for (const v of usable) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += v[i] ?? 0;
    n++;
  }
  if (!n) return [];
  for (let i = 0; i < dim; i++) acc[i] /= n;
  return acc;
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  if (d < 1e-12) return 0;
  return dot / d;
}

export function rrfMerge(ranklists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of ranklists) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function formatVector(v: number[]): string {
  const parts: string[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    parts[i] = Number.isFinite(x) ? x.toFixed(8) : "0";
  }
  return `[${parts.join(",")}]`;
}

export function parseEmbedding(raw: unknown): number[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const n = raw.map((x) => Number(x));
    return n.length ? n : undefined;
  }
  if (typeof raw === "string") {
    const s = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!s) return undefined;
    const n = s.split(",").map((x) => Number(x.trim()));
    return n.length && n.every((x) => Number.isFinite(x)) ? n : undefined;
  }
  return undefined;
}

export type EmbedTextsOpts = EmbedEndpoint & {
  fetch?: typeof fetch;
  /** Force the local hashed projector (tests; never hits network). */
  local?: boolean;
};

function resolvedEndpoint(opts?: EmbedTextsOpts): { base: string; apiKey: string; model: string } | null {
  const base = (opts?.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim() || "").replace(/\/$/, "");
  const apiKey = opts?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  if (!base || !apiKey) return null;
  const model = opts?.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  return { base, apiKey, model };
}

function padOrTrim(emb: number[]): number[] {
  if (emb.length === EMBEDDING_DIM) return emb;
  if (emb.length > EMBEDDING_DIM) return emb.slice(0, EMBEDDING_DIM);
  if (!emb.length) return emb;
  return emb.concat(new Array(EMBEDDING_DIM - emb.length).fill(0));
}

async function embedOpenAI(texts: string[], opts?: EmbedTextsOpts): Promise<number[][]> {
  const ep = resolvedEndpoint(opts);
  if (!ep) throw new Error("embeddings not configured");
  const { base, apiKey, model } = ep;
  const url = `${base}/embeddings`;
  const res = await (opts?.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings failed (${res.status})`);
  const data = (await res.json()) as {
    data?: { embedding?: number[]; index?: number }[];
  };
  const rows = data.data ?? [];
  const out: number[][] = texts.map(() => []);
  for (const row of rows) {
    const idx = row.index ?? 0;
    const emb = row.embedding ?? [];
    out[idx] = padOrTrim(emb);
  }
  for (let i = 0; i < out.length; i++) {
    if (!out[i]?.length) out[i] = localProject(texts[i] ?? "");
  }
  return out;
}

export async function embedTexts(texts: string[], opts?: EmbedTextsOpts): Promise<number[][]> {
  if (!texts.length) return [];
  if (opts?.local) {
    return texts.map(localProject);
  }

  const provider = resolveProvider(opts);
  if (provider === "local") {
    const model =
      opts?.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || DEFAULT_LOCAL_EMBED_MODEL;
    // Explicit local provider: never silently fall back to hash.
    return embedTextsLocal(texts, model);
  }

  const useOpenAI = Boolean(resolvedEndpoint(opts));
  if (useOpenAI) {
    try {
      return await embedOpenAI(texts, opts);
    } catch {
      return texts.map(localProject);
    }
  }
  return texts.map(localProject);
}

export {
  LOCAL_EMBED_CATALOG,
  DEFAULT_LOCAL_EMBED_MODEL,
  listLocalEmbedModels,
  downloadLocalEmbedModel,
  isLocalModelDownloaded,
  isLocalCatalogModel,
  embedModelDir,
  getDownloadProgress,
  type LocalEmbedCatalogEntry,
  type LocalEmbedModelStatus,
} from "./local-embed.ts";
