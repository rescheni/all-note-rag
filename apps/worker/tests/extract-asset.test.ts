import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ enoentTesseract: false }));

const tessMocks = vi.hoisted(() => {
  const recognize = vi.fn(async () => ({ data: { text: "mocked ocr from js" } }));
  const setParameters = vi.fn(async () => undefined);
  const terminate = vi.fn(async () => undefined);
  const createWorker = vi.fn(async () => ({ recognize, setParameters, terminate }));
  return { recognize, setParameters, terminate, createWorker };
});

vi.mock("tesseract.js", () => ({
  createWorker: tessMocks.createWorker,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: readonly string[], opts: Parameters<typeof actual.spawn>[2]) => {
      const name = cmd.replace(/\\/g, "/").split("/").pop() || cmd;
      if (spawnState.enoentTesseract && name === "tesseract") {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          stdin: { write: () => boolean; end: () => void };
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write: () => true, end: () => undefined };
        child.kill = () => true;
        queueMicrotask(() => {
          const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), {
            code: "ENOENT",
            errno: -2,
            syscall: "spawn",
            path: cmd,
          });
          child.emit("error", err);
        });
        return child;
      }
      return actual.spawn(cmd, args, opts);
    },
  };
});

import {
  extractAssetText,
  extractImage,
  isPlaceholderExtract,
  needsExtract,
  resetExtractEnginesForTests,
} from "../src/extract-asset.ts";

const MINI_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 55 >>stream
BT /F1 12 Tf 20 150 Td (hello extract) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
trailer<< /Root 1 0 R >>
%%EOF
`,
  "utf8",
);

const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tesseractOnPath(): boolean {
  const envBin = process.env.TESSERACT_BIN?.trim();
  if (envBin) return existsSync(envBin);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "tesseract"))) return true;
  }
  return false;
}

describe("extract-asset", () => {
  beforeEach(() => {
    spawnState.enoentTesseract = false;
    tessMocks.createWorker.mockClear();
    tessMocks.recognize.mockClear();
    resetExtractEnginesForTests();
  });

  afterEach(() => {
    spawnState.enoentTesseract = false;
    resetExtractEnginesForTests();
  });

  it("skips OCR when hash matches and extracted_text is present", () => {
    expect(needsExtract({ hash: "abc", extracted_text: "发票" }, "abc")).toBe(false);
    expect(needsExtract({ hash: "abc", extracted_text: "" }, "abc")).toBe(false);
    expect(needsExtract({ hash: "abc", extracted_text: "发票" }, "zzz")).toBe(true);
    expect(needsExtract(null, "abc")).toBe(true);
    expect(needsExtract({ hash: "abc", extracted_text: null }, "abc")).toBe(true);
  });

  it("treats pending and placeholder 图片 as needing extract", () => {
    expect(isPlaceholderExtract("图片 foo.png")).toBe(true);
    expect(isPlaceholderExtract("发票金额")).toBe(false);
    expect(
      needsExtract({ hash: "abc", extracted_text: "图片 foo.png", extract_status: "pending" }, "abc"),
    ).toBe(true);
    expect(
      needsExtract({ hash: "abc", extracted_text: "图片 foo.png", extract_status: "running" }, "abc"),
    ).toBe(true);
    expect(needsExtract({ hash: "abc", extracted_text: "图片 foo.png" }, "abc")).toBe(true);
  });

  it("skips when hash matches and status is ok with real text", () => {
    expect(
      needsExtract({ hash: "abc", extracted_text: "发票金额 123", extract_status: "ok" }, "abc"),
    ).toBe(false);
    expect(
      needsExtract({ hash: "abc", extracted_text: "图片 foo.png", extract_status: "ok" }, "abc"),
    ).toBe(true);
    expect(
      needsExtract({ hash: "abc", extracted_text: "图片 foo.png", extract_status: "empty" }, "abc"),
    ).toBe(false);
  });

  it("extracts text from a pdf via pdftotext", async () => {
    const r = await extractAssetText({ bytes: MINI_PDF, filename: "hello.pdf", contentType: "application/pdf" });
    expect(r.status === "ok" || r.status === "empty" || r.status === "error").toBe(true);
    if (r.status === "ok") expect(r.text.toLowerCase()).toContain("hello");
    else expect(r.text).toContain("hello.pdf");
  });

  it("extractImage succeeds via tesseract.js when spawn tesseract is ENOENT", async () => {
    spawnState.enoentTesseract = true;
    const r = await extractImage(MINI_PNG, "invoice.png");
    expect(tessMocks.createWorker).toHaveBeenCalled();
    expect(tessMocks.recognize).toHaveBeenCalled();
    expect(r.status).toBe("ok");
    expect(r.text).toBe("mocked ocr from js");

    const viaAsset = await extractAssetText({
      bytes: MINI_PNG,
      filename: "invoice.png",
      contentType: "image/png",
    });
    expect(viaAsset.status).toBe("ok");
    expect(viaAsset.text).toBe("mocked ocr from js");
  });

  it("uses native tesseract spawn when the binary exists", async () => {
    if (!tesseractOnPath()) return;
    spawnState.enoentTesseract = false;
    const r = await extractImage(MINI_PNG, "dot.png");
    expect(tessMocks.createWorker).not.toHaveBeenCalled();
    expect(r.status === "ok" || r.status === "empty" || r.status === "error").toBe(true);
    if (r.status === "empty") expect(r.text).toBe("");
  });
});
