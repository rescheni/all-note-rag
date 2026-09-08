import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Must match packages/retrieve embed storage dim (pgvector vector(1536)). */
const EMBEDDING_DIM = 1536;

export type LocalEmbedCatalogEntry = {
  id: string;
  label: string;
  description: string;
  dim: number;
  sizeHint: string;
  /** Recommended default for Chinese notes. */
  isDefault?: boolean;
};

export type LocalEmbedModelStatus = LocalEmbedCatalogEntry & {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  error?: string;
  bytesOnDisk?: number;
};

export type DownloadProgress = {
  status: "idle" | "downloading" | "ready" | "error";
  progress: number;
  error?: string;
  updatedAt: number;
};

/** Chinese-friendly small ONNX models via @xenova/transformers (no host apt / no Ollama). */
export const LOCAL_EMBED_CATALOG: LocalEmbedCatalogEntry[] = [
  {
    id: "Xenova/bge-small-zh-v1.5",
    label: "BGE 中文小模型（推荐）",
    description: "适合中文笔记检索，约 512 维；体积小、默认推荐。",
    dim: 512,
    sizeHint: "~30MB",
    isDefault: true,
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    label: "MiniLM 英文小模型",
    description: "英文为主的轻量嵌入，约 384 维。",
    dim: 384,
    sizeHint: "~23MB",
  },
  {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    label: "多语 MiniLM",
    description: "中英等多语种，约 384 维；比纯中文略重。",
    dim: 384,
    sizeHint: "~120MB",
  },
];

export const DEFAULT_LOCAL_EMBED_MODEL =
  LOCAL_EMBED_CATALOG.find((m) => m.isDefault)?.id ?? "Xenova/bge-small-zh-v1.5";

const progressMap = new Map<string, DownloadProgress>();
const pipelineCache = new Map<string, Promise<LocalExtractor>>();
const downloadJobs = new Map<string, Promise<LocalEmbedModelStatus>>();

type LocalExtractor = (
  texts: string | string[],
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export function embedModelDir(): string {
  const fromEnv = process.env.EMBED_MODEL_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const root = process.env.NOTE_HUB_ROOT?.trim();
  if (root) return path.resolve(root, "data", "models");
  return path.resolve(process.cwd(), "data", "models");
}

export function catalogEntry(id: string): LocalEmbedCatalogEntry | undefined {
  return LOCAL_EMBED_CATALOG.find((m) => m.id === id);
}

export function isLocalCatalogModel(id: string): boolean {
  return Boolean(catalogEntry(id)) || id.startsWith("Xenova/");
}

function modelCachePath(modelId: string): string {
  return path.join(embedModelDir(), ...modelId.split("/"));
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const name of readdirSync(p)) {
      const child = path.join(p, name);
      const st = statSync(child);
      if (st.isDirectory()) walk(child);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** True when ONNX weights look complete on disk. */
export function isLocalModelDownloaded(modelId: string): boolean {
  const base = modelCachePath(modelId);
  if (!existsSync(base)) return false;
  const onnxDir = path.join(base, "onnx");
  if (existsSync(onnxDir)) {
    try {
      if (readdirSync(onnxDir).some((f) => f.endsWith(".onnx"))) return true;
    } catch {
      /* ignore */
    }
  }
  try {
    if (readdirSync(base).some((f) => f.endsWith(".onnx"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function getDownloadProgress(modelId: string): DownloadProgress {
  return (
    progressMap.get(modelId) ?? {
      status: isLocalModelDownloaded(modelId) ? "ready" : "idle",
      progress: isLocalModelDownloaded(modelId) ? 100 : 0,
      updatedAt: Date.now(),
    }
  );
}

export function listLocalEmbedModels(): LocalEmbedModelStatus[] {
  return LOCAL_EMBED_CATALOG.map((entry) => {
    const prog = getDownloadProgress(entry.id);
    const downloaded = isLocalModelDownloaded(entry.id);
    const bytes = downloaded ? dirBytes(modelCachePath(entry.id)) : undefined;
    return {
      ...entry,
      downloaded,
      downloading: prog.status === "downloading",
      progress: prog.status === "downloading" ? prog.progress : downloaded ? 100 : 0,
      error: prog.status === "error" ? prog.error : undefined,
      bytesOnDisk: bytes,
    };
  });
}

function setProgress(modelId: string, patch: Partial<DownloadProgress>) {
  const prev = getDownloadProgress(modelId);
  progressMap.set(modelId, {
    status: patch.status ?? prev.status,
    progress: patch.progress ?? prev.progress,
    error: patch.error,
    updatedAt: Date.now(),
  });
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function configureTransformersEnv() {
  await ensureDir(embedModelDir());
  const { env } = await import("@xenova/transformers");
  env.cacheDir = embedModelDir();
  env.allowLocalModels = true;
  // @ts-expect-error older typings may omit useBrowserCache
  env.useBrowserCache = false;
  env.useFSCache = true;
  return env;
}

type ProgressInfo = {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
};

/**
 * Prefetch model files into EMBED_MODEL_DIR using transformers.js pipeline.
 * Concurrent calls for the same id share one job.
 */
export async function downloadLocalEmbedModel(modelId: string): Promise<LocalEmbedModelStatus> {
  if (!catalogEntry(modelId) && !modelId.startsWith("Xenova/")) {
    throw new Error(`未知本地嵌入模型：${modelId}`);
  }
  const inflight = downloadJobs.get(modelId);
  if (inflight) return inflight;

  const job = (async () => {
    if (isLocalModelDownloaded(modelId)) {
      setProgress(modelId, { status: "ready", progress: 100, error: undefined });
      void getLocalPipeline(modelId).catch(() => undefined);
      return listLocalEmbedModels().find((m) => m.id === modelId)!;
    }

    setProgress(modelId, { status: "downloading", progress: 1, error: undefined });
    try {
      await configureTransformersEnv();
      const { pipeline } = await import("@xenova/transformers");
      await pipeline("feature-extraction", modelId, {
        progress_callback: (info: ProgressInfo) => {
          const file = info?.file || "";
          if (info?.status === "ready") {
            setProgress(modelId, { status: "downloading", progress: 99 });
            return;
          }
          if (typeof info?.loaded === "number" && typeof info?.total === "number" && info.total > 0) {
            // Prefer ONNX weights for overall %; tokenizer spam reports progress=100 per chunk.
            if (/\.onnx$/i.test(file) || getDownloadProgress(modelId).progress < 5) {
              const p = Math.max(1, Math.min(99, Math.round((100 * info.loaded) / info.total)));
              if (/\.onnx$/i.test(file) || p > getDownloadProgress(modelId).progress) {
                setProgress(modelId, { status: "downloading", progress: p });
              }
            }
          } else if (info?.status === "done" && /\.onnx$/i.test(file)) {
            setProgress(modelId, { status: "downloading", progress: 95 });
          }
        },
      } as { progress_callback?: (info: ProgressInfo) => void });

      pipelineCache.delete(modelId);
      await getLocalPipeline(modelId);

      if (!isLocalModelDownloaded(modelId)) {
        throw new Error("模型文件未写入磁盘，请重试下载");
      }
      try {
        await writeFile(
          path.join(modelCachePath(modelId), ".note-hub-ready"),
          `${modelId}\n${new Date().toISOString()}\n`,
          "utf8",
        );
      } catch {
        /* marker optional */
      }
      setProgress(modelId, { status: "ready", progress: 100, error: undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProgress(modelId, { status: "error", progress: 0, error: msg.slice(0, 240) });
      pipelineCache.delete(modelId);
      throw new Error(`下载本地嵌入模型失败：${msg.slice(0, 200)}`);
    } finally {
      downloadJobs.delete(modelId);
    }
    return listLocalEmbedModels().find((m) => m.id === modelId)!;
  })();

  downloadJobs.set(modelId, job);
  return job;
}

async function getLocalPipeline(modelId: string): Promise<LocalExtractor> {
  const hit = pipelineCache.get(modelId);
  if (hit) return hit;

  const job = (async () => {
    await configureTransformersEnv();
    const { pipeline } = await import("@xenova/transformers");
    const extractor = await pipeline("feature-extraction", modelId);
    return extractor as unknown as LocalExtractor;
  })();

  pipelineCache.set(modelId, job);
  try {
    return await job;
  } catch (e) {
    pipelineCache.delete(modelId);
    throw e;
  }
}

function padToStorageDim(vec: number[]): number[] {
  if (vec.length === EMBEDDING_DIM) return vec;
  if (vec.length > EMBEDDING_DIM) return vec.slice(0, EMBEDDING_DIM);
  if (!vec.length) return new Array(EMBEDDING_DIM).fill(0);
  // Zero-pad keeps unit-norm for already L2-normalized inputs.
  return vec.concat(new Array(EMBEDDING_DIM - vec.length).fill(0));
}

function tensorToVector(out: { data: Float32Array; dims: number[] } | Float32Array): number[] {
  if (out instanceof Float32Array) return Array.from(out);
  if (out && out.data) return Array.from(out.data);
  return [];
}

/**
 * Run local ONNX embedding. Requires model files under EMBED_MODEL_DIR.
 * Throws a clear Chinese error if not downloaded.
 */
export async function embedTextsLocal(texts: string[], modelId: string): Promise<number[][]> {
  if (!texts.length) return [];
  const id = modelId.trim() || DEFAULT_LOCAL_EMBED_MODEL;
  if (!isLocalModelDownloaded(id) && !pipelineCache.has(id)) {
    throw new Error("请先下载本地嵌入模型");
  }
  try {
    const extractor = await getLocalPipeline(id);
    const out: number[][] = [];
    for (const text of texts) {
      const raw = await extractor(text || " ", { pooling: "mean", normalize: true });
      out.push(padToStorageDim(tensorToVector(raw)));
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/请先下载/.test(msg)) throw e;
    if (/fetch|ENOTFOUND|network|404|download/i.test(msg) && !isLocalModelDownloaded(id)) {
      throw new Error("请先下载本地嵌入模型");
    }
    throw new Error(`本地嵌入失败：${msg.slice(0, 200)}`);
  }
}

/** Test helper — clear in-memory download/pipeline state. */
export function _resetLocalEmbedStateForTests() {
  progressMap.clear();
  pipelineCache.clear();
  downloadJobs.clear();
}
