import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guessContentType, isImagePath } from "@note-hub/core";

export type ExtractStatus = "ok" | "empty" | "error" | "skipped" | "pending" | "running";

export type ExtractResult = {
  text: string;
  status: ExtractStatus;
};

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const OCR_LANGS = "chi_sim+eng";
const JS_LANGS = ["eng", "chi_sim"] as const;

const PLACEHOLDER_RE = /^图片\s/;

const requireFromHere = createRequire(import.meta.url);

export type ExtractPrev = {
  hash?: string | null;
  extracted_text?: string | null;
  extract_status?: string | null;
};

/** Filename fallback written on the ingest hot path, e.g. "图片 foo.png". */
export function isPlaceholderExtract(text: string | null | undefined): boolean {
  return typeof text === "string" && PLACEHOLDER_RE.test(text);
}

/**
 * Drain-path check: pending / placeholder / hash change still need OCR.
 * Hash match + status ok with real text skips. empty/skipped are done.
 */
export function needsExtract(prev: ExtractPrev | null | undefined, hash: string): boolean {
  if (!prev) return true;
  if ((prev.hash ?? "") !== hash) return true;
  const status = prev.extract_status ?? "";
  if (status === "pending" || status === "running" || status === "error") return true;
  if (status === "ok") {
    return prev.extracted_text == null || isPlaceholderExtract(prev.extracted_text);
  }
  if (status === "empty" || status === "skipped") return false;
  if (prev.extracted_text == null) return true;
  if (isPlaceholderExtract(prev.extracted_text)) return true;
  return false;
}

/** Sync hot path: reuse blob + existing extract when the bytes have not changed. */
export function canReuseHotPath(prev: ExtractPrev | null | undefined, hash: string): boolean {
  return Boolean(prev && (prev.hash ?? "") === hash);
}

export function assetHeadingPath(filename: string, contentType?: string): string {
  const image = (contentType ?? "").startsWith("image/") || isImagePath(filename);
  return image ? `图片/${filename}` : `附件/${filename}`;
}

function fallbackText(filename: string, contentType?: string): string {
  const heading = assetHeadingPath(filename, contentType);
  const kind = heading.startsWith("图片/") ? "图片" : "附件";
  return `${kind} ${filename}`.trim();
}

function isEnoent(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "ENOENT");
}

function binBasename(cmd: string): string {
  return cmd.replace(/\\/g, "/").split("/").pop() || cmd;
}

/** Native tesseract/pdftotext/antiword come from the worker image (apt); this module falls back to tesseract.js from node_modules when those binaries are missing. */
type NativeCache = string | null | undefined;

let tesseractBinCache: NativeCache;
let pdftotextBinCache: NativeCache;
let antiwordBinCache: NativeCache;
let ocrEngineLogged = false;
let pdfEngineLogged = false;
let antiwordEngineLogged = false;

type JsWorker = {
  recognize: (image: Buffer | Uint8Array | string) => Promise<{ data: { text: string } }>;
  setParameters: (p: Record<string, string>) => Promise<void>;
  terminate: () => Promise<void>;
};

let jsWorkerPromise: Promise<JsWorker> | null = null;
let jsChain: Promise<unknown> = Promise.resolve();

export function resetExtractEnginesForTests(): void {
  tesseractBinCache = undefined;
  pdftotextBinCache = undefined;
  antiwordBinCache = undefined;
  ocrEngineLogged = false;
  pdfEngineLogged = false;
  antiwordEngineLogged = false;
  jsWorkerPromise = null;
  jsChain = Promise.resolve();
}

function logOcrEngineOnce(engine: "tesseract" | "tesseract.js", bin?: string): void {
  if (ocrEngineLogged) return;
  ocrEngineLogged = true;
  console.log(
    JSON.stringify({
      level: "info",
      message: "ocr engine",
      engine,
      bin: bin ?? null,
    }),
  );
}

function logPdfEngineOnce(engine: "pdftotext" | "missing", bin?: string): void {
  if (pdfEngineLogged) return;
  pdfEngineLogged = true;
  console.log(
    JSON.stringify({
      level: "info",
      message: "pdf extract engine",
      engine,
      bin: bin ?? null,
    }),
  );
}

function logAntiwordEngineOnce(engine: "antiword" | "missing", bin?: string): void {
  if (antiwordEngineLogged) return;
  antiwordEngineLogged = true;
  console.log(
    JSON.stringify({
      level: "info",
      message: "doc extract engine",
      engine,
      bin: bin ?? null,
    }),
  );
}

function nativeCandidates(envName: string, fallback: string): string[] {
  const envBin = process.env[envName]?.trim();
  const out: string[] = [];
  if (envBin) out.push(envBin);
  if (!envBin || binBasename(envBin) !== fallback) out.push(fallback);
  return out;
}

async function runCommand(
  cmd: string,
  args: string[],
  opts?: { input?: Uint8Array; timeoutMs?: number; cwd?: string },
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        code,
      });
    });
    if (opts?.input && child.stdin) {
      child.stdin.write(Buffer.from(opts.input));
    }
    child.stdin?.end();
  });
}

async function withTempFile(bytes: Uint8Array, ext: string, fn: (file: string) => Promise<ExtractResult>): Promise<ExtractResult> {
  const dir = await mkdtemp(join(tmpdir(), "hub-extract-"));
  const file = join(dir, `file${ext.startsWith(".") ? ext : `.${ext}`}`);
  try {
    await writeFile(file, Buffer.from(bytes));
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function traineddataGz(lang: (typeof JS_LANGS)[number]): string {
  const pkg = dirname(requireFromHere.resolve(`@tesseract.js-data/${lang}/package.json`));
  const bestInt = join(pkg, "4.0.0_best_int", `${lang}.traineddata.gz`);
  const v400 = join(pkg, "4.0.0", `${lang}.traineddata.gz`);
  if (existsSync(bestInt)) return bestInt;
  if (existsSync(v400)) return v400;
  throw new Error(`missing ${lang} traineddata in node_modules`);
}

/** Combined langPath so createWorker can load chi_sim+eng from node_modules, not TESSDATA_PREFIX. */
async function ensureJsLangPath(): Promise<string> {
  const dest = join(dirname(requireFromHere.resolve("@tesseract.js-data/eng/package.json")), "..", "note-hub-combined");
  await mkdir(dest, { recursive: true });
  for (const lang of JS_LANGS) {
    const src = traineddataGz(lang);
    const dst = join(dest, `${lang}.traineddata.gz`);
    if (!existsSync(dst) || (await stat(dst)).size !== (await stat(src)).size) {
      await copyFile(src, dst);
    }
  }
  return dest;
}

async function getJsWorker(): Promise<JsWorker> {
  if (!jsWorkerPromise) {
    jsWorkerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const langPath = await ensureJsLangPath();
      const worker = (await createWorker(OCR_LANGS, 1, {
        langPath,
        gzip: true,
        cachePath: langPath,
        cacheMethod: "readOnly",
      })) as JsWorker;
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      return worker;
    })();
  }
  return jsWorkerPromise;
}

async function extractImageJs(bytes: Uint8Array): Promise<ExtractResult> {
  const run = jsChain.then(async () => {
    const worker = await getJsWorker();
    const { data } = await worker.recognize(Buffer.from(bytes));
    const text = String(data?.text ?? "").replace(/\u0000/g, "").trim();
    return { text, status: (text ? "ok" : "empty") as ExtractStatus };
  });
  jsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function spawnNative(
  cache: { get: () => NativeCache; set: (v: string | null) => void },
  envName: string,
  fallback: string,
  run: (bin: string) => Promise<ExtractResult>,
): Promise<{ result: ExtractResult; bin: string } | { missing: true }> {
  const cached = cache.get();
  const candidates = cached ? [cached] : nativeCandidates(envName, fallback);
  for (const bin of candidates) {
    try {
      const result = await run(bin);
      cache.set(bin);
      return { result, bin };
    } catch (e) {
      if (isEnoent(e)) continue;
      throw e;
    }
  }
  cache.set(null);
  return { missing: true };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  try {
    const hit = await spawnNative(
      { get: () => pdftotextBinCache, set: (v) => { pdftotextBinCache = v; } },
      "PDFTOTEXT_BIN",
      "pdftotext",
      async (bin) => {
        const r = await runCommand(bin, ["-q", "-", "-"], { input: bytes });
        const text = r.stdout.toString("utf8").replace(/\u0000/g, "").trim();
        if (r.code !== 0 && !text) return { text: "", status: "error" };
        return { text, status: text ? "ok" : "empty" };
      },
    );
    if ("missing" in hit) {
      logPdfEngineOnce("missing");
      console.error(JSON.stringify({ level: "warn", message: "pdftotext unavailable, skip pdf" }));
      return { text: "", status: "error" };
    }
    logPdfEngineOnce("pdftotext", hit.bin);
    return hit.result;
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", message: "pdftotext failed", error: e instanceof Error ? e.message : String(e) }));
    return { text: "", status: "error" };
  }
}

export async function extractImage(bytes: Uint8Array, filename: string): Promise<ExtractResult> {
  const ext = (filename.split(".").pop() || "png").toLowerCase();
  try {
    const hit = await spawnNative(
      { get: () => tesseractBinCache, set: (v) => { tesseractBinCache = v; } },
      "TESSERACT_BIN",
      "tesseract",
      async (bin) =>
        withTempFile(bytes, ext, async (file) => {
          const r = await runCommand(bin, [file, "stdout", "-l", OCR_LANGS, "--psm", "6"]);
          const text = r.stdout.toString("utf8").replace(/\u0000/g, "").trim();
          if (r.code !== 0 && !text) return { text: "", status: "error" };
          return { text, status: text ? "ok" : "empty" };
        }),
    );
    if (!("missing" in hit)) {
      logOcrEngineOnce("tesseract", hit.bin);
      return hit.result;
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", message: "tesseract failed", error: e instanceof Error ? e.message : String(e) }));
    return { text: "", status: "error" };
  }

  try {
    logOcrEngineOnce("tesseract.js");
    return await extractImageJs(bytes);
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", message: "tesseract.js failed", error: e instanceof Error ? e.message : String(e) }));
    return { text: "", status: "error" };
  }
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractResult> {
  try {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = String(r.value ?? "").replace(/\u0000/g, "").trim();
    return { text, status: text ? "ok" : "empty" };
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", message: "mammoth failed", error: e instanceof Error ? e.message : String(e) }));
    return { text: "", status: "error" };
  }
}

async function extractDoc(bytes: Uint8Array, filename: string): Promise<ExtractResult> {
  try {
    const hit = await spawnNative(
      { get: () => antiwordBinCache, set: (v) => { antiwordBinCache = v; } },
      "ANTIWORD_BIN",
      "antiword",
      async (bin) =>
        withTempFile(bytes, "doc", async (file) => {
          const r = await runCommand(bin, [file]);
          const text = r.stdout.toString("utf8").replace(/\u0000/g, "").trim();
          if (r.code !== 0 && !text) {
            console.error(JSON.stringify({ level: "warn", message: "antiword skipped .doc", file: filename }));
            return { text: "", status: "skipped" };
          }
          return { text, status: text ? "ok" : "empty" };
        }),
    );
    if ("missing" in hit) {
      logAntiwordEngineOnce("missing");
      console.error(JSON.stringify({ level: "warn", message: "antiword unavailable, skip .doc" }));
      return { text: "", status: "skipped" };
    }
    logAntiwordEngineOnce("antiword", hit.bin);
    return hit.result;
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", message: "antiword unavailable, skip .doc", error: e instanceof Error ? e.message : String(e) }));
    return { text: "", status: "skipped" };
  }
}

export async function extractAssetText(opts: {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
}): Promise<ExtractResult> {
  const filename = opts.filename || "file";
  const ct = (opts.contentType || guessContentType(filename)).toLowerCase();
  if (opts.bytes.byteLength > MAX_BYTES) {
    return { text: fallbackText(filename, ct), status: "skipped" };
  }
  let result: ExtractResult;
  if (ct.startsWith("image/") || isImagePath(filename)) {
    result = await extractImage(opts.bytes, filename);
  } else if (ct === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    result = await extractPdf(opts.bytes);
  } else if (ct.includes("wordprocessingml") || filename.toLowerCase().endsWith(".docx")) {
    result = await extractDocx(opts.bytes);
  } else if (ct === "application/msword" || filename.toLowerCase().endsWith(".doc")) {
    result = await extractDoc(opts.bytes, filename);
  } else {
    result = { text: "", status: "skipped" };
  }
  const body = result.text.trim();
  if (!body) {
    return { text: fallbackText(filename, ct), status: result.status === "error" ? "error" : result.status === "skipped" ? "skipped" : "empty" };
  }
  return { text: body, status: result.status };
}
