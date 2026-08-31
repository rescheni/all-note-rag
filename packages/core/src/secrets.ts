import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function keyFromHubSecret(hubSecret: string): Buffer {
  return createHash("sha256").update(hubSecret, "utf8").digest();
}

/** AES-256-GCM blob: base64(iv 12 | tag 16 | ciphertext) */
export function encryptSecret(plain: string, hubSecret: string): string {
  const key = keyFromHubSecret(hubSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(blob: string, hubSecret: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const key = keyFromHubSecret(hubSecret);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
