import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

export function shortFingerprint(text: string, len = 8): string {
  return sha256Hex(text.trim()).slice(0, len);
}

export function lf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Canonical markdown: UTF-8, LF, exactly one trailing newline. */
export function canonicalizeBody(body: string): string {
  const n = lf(body).replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  return n + "\n";
}
