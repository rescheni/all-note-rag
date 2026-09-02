import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { decompress as zstdDecompress } from "fzstd";
import {
  HubError,
  posixVaultPath,
  prefixHasRepoSegment,
  SIYUAN_REPO_PASSWORD_INCORRECT_CODE,
  SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE,
  SIYUAN_REPO_PASSWORD_REQUIRED_CODE,
  SIYUAN_REPO_PASSWORD_REQUIRED_MESSAGE,
  collectAssetRefs,
  isImagePath,
  parseSiyuanUpdated,
  type Change,
  type ConnectionSecrets,
  type NotePayload,
} from "@note-hub/core";

export type ByteStore = {
  list(prefix: string): Promise<{ key: string; etag?: string }[]>;
  get(key: string): Promise<Uint8Array | null>;
};

export type DejavuIndex = {
  id: string;
  memo?: string;
  created?: number;
  files?: string[];
  count?: number;
  size?: number;
  aesKeyVerifyVal?: string;
};

export type DejavuFile = {
  id: string;
  path: string;
  size?: number;
  updated?: number;
  chunks?: string[];
};

export type OfficialCursorFile = {
  id: string;
  path: string;
  chunks: string[];
  updated?: number;
};

export type OfficialCursor = {
  etags: Record<string, string>;
  files: Record<string, OfficialCursorFile>;
  indexId?: string;
  repoRoot?: string;
  boxNames?: Record<string, string>;
};

const BOX_RE = /^(\d{14}-[0-9a-z]+)$/i;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function asBuf(data: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function repoPasswordFromSecrets(secrets: ConnectionSecrets | null | undefined): string {
  const s = (secrets ?? {}) as Record<string, unknown>;
  for (const k of ["repo_password", "repo_key", "passphrase"]) {
    const v = s[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isStdBase64(s: string): boolean {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Derive the 32-byte AES key from a data-repo passphrase. Never log the input. */
export function deriveRepoAesKey(passphrase: string): Buffer {
  const pass = passphrase.trim();
  if (isStdBase64(pass)) {
    const decoded = Buffer.from(pass, "base64");
    if (decoded.length === 32) return decoded;
  }
  const salt = createHash("sha256").update(pass, "utf8").digest("hex").slice(0, 16);
  return scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
}

export function aesEncrypt(plain: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(asBuf(plain)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

export function aesDecrypt(crypt: Uint8Array, key: Buffer): Buffer {
  const buf = asBuf(crypt);
  if (buf.length < 28) throw new Error("encrypted data too short");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Uncompressed zstd frame (valid zstd; used to build synthetic objects). */
export function zstdCompress(data: Uint8Array): Buffer {
  const size = data.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0xfd2fb528, 0);
  header[4] = 0xa0;
  header.writeUInt32LE(size, 5);
  const bh = 1 | (size << 3);
  header[9] = bh & 0xff;
  header[10] = (bh >> 8) & 0xff;
  header[11] = (bh >> 16) & 0xff;
  return Buffer.concat([header, asBuf(data)]);
}

export function zstdDecompressBytes(data: Uint8Array): Buffer {
  return Buffer.from(zstdDecompress(data));
}

function isZstd(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === ZSTD_MAGIC[0] && data[1] === ZSTD_MAGIC[1] && data[2] === ZSTD_MAGIC[2] && data[3] === ZSTD_MAGIC[3];
}

export function decodeZstdOrJson(bytes: Uint8Array): unknown {
  if (isZstd(bytes)) {
    const dec = zstdDecompressBytes(bytes);
    return JSON.parse(dec.toString("utf8"));
  }
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      /* try zstd anyway */
    }
  }
  const dec = zstdDecompressBytes(bytes);
  return JSON.parse(dec.toString("utf8"));
}

/** File/chunk objects: zstd then AES-GCM. Decode: AES then zstd. */
export function encodeObject(plain: Uint8Array, aesKey: Buffer): Buffer {
  return aesEncrypt(zstdCompress(plain), aesKey);
}

export function decodeObject(crypt: Uint8Array, aesKey: Buffer): Buffer {
  const decrypted = aesDecrypt(crypt, aesKey);
  return zstdDecompressBytes(decrypted);
}

export function buildAesKeyVerifyVal(aesKey: Buffer): string {
  return aesEncrypt(Buffer.from("siyuan", "utf8"), aesKey).toString("base64");
}

export function verifyAesKey(verifyVal: string | undefined | null, aesKey: Buffer): boolean {
  if (!verifyVal) return true;
  try {
    const plain = aesDecrypt(Buffer.from(verifyVal, "base64"), aesKey);
    return plain.toString("utf8") === "siyuan";
  } catch {
    return false;
  }
}

export function objectStoreKey(repoRoot: string, id: string): string {
  const root = posixVaultPath(repoRoot).replace(/\/+$/, "");
  return `${root}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
}

export function indexStoreKey(repoRoot: string, id: string): string {
  const root = posixVaultPath(repoRoot).replace(/\/+$/, "");
  return `${root}/indexes/${id}`;
}

export function looksLikeOfficialRepo(keys: string[], prefix: string): boolean {
  if (prefixHasRepoSegment(prefix) || prefix === "repo" || prefix.endsWith("/repo")) return true;
  const rels = keys.map((k) => {
    const p = posixVaultPath(k);
    if (prefix && (p === prefix || p.startsWith(prefix + "/"))) return p.slice(prefix.length).replace(/^\/+/, "");
    return p;
  });
  const hasSy = rels.some((k) => k.endsWith(".sy"));
  const hasRepo = rels.some((k) => k.split("/").includes("repo"));
  return hasRepo && !hasSy;
}

export async function detectOfficialRepo(
  store: ByteStore,
  listed: { key: string }[],
  prefix: string,
): Promise<boolean> {
  const keys = listed.map((x) => x.key);
  if (looksLikeOfficialRepo(keys, prefix)) return true;
  if (keys.some((k) => posixVaultPath(k).endsWith(".sy"))) return false;
  const p = posixVaultPath(prefix).replace(/\/+$/, "");
  const checks = ["repo/indexes-v2.json", "repo/refs/latest"];
  if (p) checks.push(`${p}/repo/indexes-v2.json`, `${p}/repo/refs/latest`);
  for (const k of checks) {
    if (await store.get(k)) return true;
  }
  return false;
}

export async function resolveRepoRoot(store: ByteStore, prefix: string): Promise<string> {
  const p = posixVaultPath(prefix).replace(/\/+$/, "");
  if (p === "repo" || p.endsWith("/repo")) return p;
  if (p && p.split("/").includes("repo")) {
    const parts = p.split("/");
    const i = parts.indexOf("repo");
    return parts.slice(0, i + 1).join("/");
  }
  const candidates = ["repo"];
  if (p) candidates.unshift(`${p}/repo`);
  for (const root of candidates) {
    if ((await store.get(`${root}/indexes-v2.json`)) || (await store.get(`${root}/refs/latest`))) return root;
  }
  return "repo";
}

type IndexEntry = { id: string; created?: number };

function normalizeIndexesV2(parsed: unknown): IndexEntry[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed
      .map((x) => asIndexEntry(x))
      .filter((x): x is IndexEntry => Boolean(x));
  }
  if (typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    const list = rec.indexes ?? rec.Indexes;
    if (Array.isArray(list)) {
      return list.map((x) => asIndexEntry(x)).filter((x): x is IndexEntry => Boolean(x));
    }
  }
  return [];
}

function asIndexEntry(x: unknown): IndexEntry | null {
  if (!x || typeof x !== "object") return null;
  const rec = x as Record<string, unknown>;
  const id = String(rec.id ?? rec.ID ?? "").trim();
  if (!id) return null;
  const createdRaw = rec.created ?? rec.Created;
  const created = typeof createdRaw === "number" ? createdRaw : typeof createdRaw === "string" ? Number(createdRaw) : undefined;
  return { id, created: Number.isFinite(created) ? created : undefined };
}

function pickLatestId(entries: IndexEntry[], latestRef: string): string {
  const ref = latestRef.trim();
  if (ref) return ref;
  const withCreated = entries.filter((e) => typeof e.created === "number");
  if (withCreated.length) {
    withCreated.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return withCreated[0].id;
  }
  return entries.length ? entries[entries.length - 1].id : "";
}

async function loadIndex(store: ByteStore, repoRoot: string, id: string): Promise<DejavuIndex> {
  const raw = await store.get(indexStoreKey(repoRoot, id));
  if (!raw) throw new HubError("siyuan_repo_index_missing", "未找到云端快照索引", 400);
  const parsed = decodeZstdOrJson(raw) as Record<string, unknown>;
  return {
    id: String(parsed.id ?? id),
    memo: typeof parsed.memo === "string" ? parsed.memo : undefined,
    created: typeof parsed.created === "number" ? parsed.created : undefined,
    files: Array.isArray(parsed.files) ? parsed.files.map((x) => String(x)) : [],
    count: typeof parsed.count === "number" ? parsed.count : undefined,
    size: typeof parsed.size === "number" ? parsed.size : undefined,
    aesKeyVerifyVal: typeof parsed.aesKeyVerifyVal === "string" ? parsed.aesKeyVerifyVal : "",
  };
}

export async function loadLatestIndex(store: ByteStore, repoRoot: string): Promise<DejavuIndex> {
  const latestRaw = await store.get(`${repoRoot}/refs/latest`);
  const latestRef = latestRaw ? new TextDecoder().decode(latestRaw).trim() : "";
  let entries: IndexEntry[] = [];
  const v2 = await store.get(`${repoRoot}/indexes-v2.json`);
  if (v2) {
    try {
      entries = normalizeIndexesV2(decodeZstdOrJson(v2));
    } catch {
      entries = [];
    }
  }
  const id = pickLatestId(entries, latestRef);
  if (!id) throw new HubError("siyuan_repo_index_missing", "未找到云端快照索引", 400);
  return loadIndex(store, repoRoot, id);
}

export type RepoFileKind = "doc" | "conf" | "asset" | "skip";

export type ClassifiedRepoPath = {
  kind: RepoFileKind;
  boxId: string;
  sourceId: string;
  path: string;
  reason?: string;
};

function isLooseAssetName(file: string): boolean {
  return isImagePath(file) || /\.(pdf|docx?)$/i.test(file);
}

export function classifyRepoFilePath(filePath: string): ClassifiedRepoPath {
  const rel = posixVaultPath(filePath);
  const work = rel.startsWith("data/") ? rel.slice("data/".length) : rel;
  if (!work) return { kind: "skip", boxId: "", sourceId: "", path: rel, reason: "empty" };
  if (work.startsWith("temp/") || work.split("/").includes("temp")) {
    return { kind: "skip", boxId: "", sourceId: "", path: rel, reason: "temp" };
  }
  const parts = work.split("/").filter(Boolean);
  if (!parts.length) return { kind: "skip", boxId: "", sourceId: "", path: rel, reason: "empty" };
  // Workspace-root assets/ (first segment is not a 14-digit box id).
  if (parts[0] === "assets") {
    if (parts.length < 2) return { kind: "skip", boxId: "_", sourceId: "", path: rel, reason: "shallow" };
    const relAsset = parts.join("/");
    return { kind: "asset", boxId: "_", sourceId: `asset:_:${relAsset}`, path: rel };
  }
  if (parts.length < 2) return { kind: "skip", boxId: "", sourceId: "", path: rel, reason: "shallow" };
  const boxId = parts[0];
  if (!BOX_RE.test(boxId)) return { kind: "skip", boxId, sourceId: "", path: rel, reason: "box" };
  if (parts[1] === "assets") {
    const relAsset = parts.slice(1).join("/");
    return { kind: "asset", boxId, sourceId: `asset:${boxId}:${relAsset}`, path: rel };
  }
  const file = parts[parts.length - 1] ?? "";
  if (file === "conf.json" && parts[1] === ".siyuan") {
    return { kind: "conf", boxId, sourceId: "", path: rel };
  }
  if (isLooseAssetName(file)) {
    const relAsset = parts.slice(1).join("/");
    return { kind: "asset", boxId, sourceId: `asset:${boxId}:${relAsset}`, path: rel };
  }
  if (!file.toLowerCase().endsWith(".sy")) {
    return { kind: "skip", boxId, sourceId: "", path: rel, reason: "not-sy" };
  }
  return { kind: "doc", boxId, sourceId: file.replace(/\.sy$/i, ""), path: rel };
}

/** Replace a notebook box id with conf.json `name` when known. Does not invent names. */
export function rewriteBoxPath(filePath: string, boxId: string, boxName: string | undefined | null): string {
  const name = (boxName ?? "").trim();
  const original = posixVaultPath(filePath);
  if (!name || !boxId) return original;
  const prefix = original.startsWith("data/") ? "data/" : "";
  const work = prefix ? original.slice("data/".length) : original;
  if (work === boxId) return `${prefix}${name}`;
  if (work.startsWith(boxId + "/")) return `${prefix}${name}/${work.slice(boxId.length + 1)}`;
  return original;
}

function displayRepoPath(info: ClassifiedRepoPath, boxNames: Map<string, string> | Record<string, string>): string {
  const names = boxNames instanceof Map ? boxNames : new Map(Object.entries(boxNames));
  return rewriteBoxPath(info.path, info.boxId, names.get(info.boxId));
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function getFileMeta(store: ByteStore, repoRoot: string, id: string, aesKey: Buffer): Promise<DejavuFile | null> {
  if (!id || id.length < 2) return null;
  const raw = await store.get(objectStoreKey(repoRoot, id));
  if (!raw) return null;
  try {
    const plain = decodeObject(raw, aesKey);
    const rec = JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
    const chunks = Array.isArray(rec.chunks) ? rec.chunks.map((x) => String(x)) : [];
    return {
      id: String(rec.id ?? id),
      path: String(rec.path ?? ""),
      size: typeof rec.size === "number" ? rec.size : undefined,
      updated: typeof rec.updated === "number" ? rec.updated : undefined,
      chunks,
    };
  } catch {
    return null;
  }
}

async function getChunkBytes(store: ByteStore, repoRoot: string, id: string, aesKey: Buffer): Promise<Buffer | null> {
  if (!id || id.length < 2) return null;
  const raw = await store.get(objectStoreKey(repoRoot, id));
  if (!raw) return null;
  try {
    return decodeObject(raw, aesKey);
  } catch {
    return null;
  }
}

const ASSEMBLE_CONCURRENCY = 8;
let assembleActive = 0;
const assembleWait: (() => void)[] = [];

async function withAssembleSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (assembleActive >= ASSEMBLE_CONCURRENCY) {
    await new Promise<void>((resolve) => assembleWait.push(resolve));
  }
  assembleActive++;
  try {
    return await fn();
  } finally {
    assembleActive--;
    assembleWait.shift()?.();
  }
}

async function assembleFile(store: ByteStore, repoRoot: string, file: DejavuFile, aesKey: Buffer): Promise<Buffer | null> {
  const chunks = file.chunks ?? [];
  if (!chunks.length) return Buffer.alloc(0);
  const parts = await mapPool(chunks, ASSEMBLE_CONCURRENCY, (cid) =>
    withAssembleSlot(() => getChunkBytes(store, repoRoot, cid, aesKey)),
  );
  if (parts.some((b) => !b)) return null;
  return Buffer.concat(parts as Buffer[]);
}

function requirePassword(secrets: ConnectionSecrets | null | undefined): string {
  const password = repoPasswordFromSecrets(secrets);
  if (!password) {
    throw new HubError(SIYUAN_REPO_PASSWORD_REQUIRED_CODE, SIYUAN_REPO_PASSWORD_REQUIRED_MESSAGE, 400);
  }
  return password;
}

export async function probeOfficialRepo(
  store: ByteStore,
  secrets: ConnectionSecrets | null | undefined,
  prefix: string,
): Promise<void> {
  const password = requirePassword(secrets);
  const aesKey = deriveRepoAesKey(password);
  const repoRoot = await resolveRepoRoot(store, prefix);
  const index = await loadLatestIndex(store, repoRoot);
  if (!verifyAesKey(index.aesKeyVerifyVal, aesKey)) {
    throw new HubError(SIYUAN_REPO_PASSWORD_INCORRECT_CODE, SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE, 400);
  }
  const sampleId = index.files?.find((id) => id && id.length >= 2);
  if (!index.aesKeyVerifyVal && sampleId) {
    const sample = await getFileMeta(store, repoRoot, sampleId, aesKey);
    if (!sample) {
      throw new HubError(SIYUAN_REPO_PASSWORD_INCORRECT_CODE, SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE, 400);
    }
  }
}

export async function listOfficialChanges(
  store: ByteStore,
  secrets: ConnectionSecrets | null | undefined,
  prefix: string,
  prevEtags: Record<string, string>,
): Promise<{ changes: Change[]; nextCursor: OfficialCursor }> {
  const password = requirePassword(secrets);
  const aesKey = deriveRepoAesKey(password);
  const repoRoot = await resolveRepoRoot(store, prefix);
  const index = await loadLatestIndex(store, repoRoot);
  if (!verifyAesKey(index.aesKeyVerifyVal, aesKey)) {
    throw new HubError(SIYUAN_REPO_PASSWORD_INCORRECT_CODE, SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE, 400);
  }
  const fileIds = index.files ?? [];
  const metas = await mapPool(fileIds, 16, (id) => getFileMeta(store, repoRoot, id, aesKey));
  if (fileIds.length && !metas.some(Boolean)) {
    throw new HubError(SIYUAN_REPO_PASSWORD_INCORRECT_CODE, SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE, 400);
  }

  const classified: { meta: DejavuFile; info: ClassifiedRepoPath }[] = [];
  for (const meta of metas) {
    if (!meta?.path) continue;
    classified.push({ meta, info: classifyRepoFilePath(meta.path) });
  }

  const encryptedBoxes = new Set<string>();
  const boxNames = new Map<string, string>();
  const confs = classified.filter((x) => x.info.kind === "conf");
  await mapPool(confs, 4, async ({ meta, info }) => {
    const body = await assembleFile(store, repoRoot, meta, aesKey);
    if (!body) {
      encryptedBoxes.add(info.boxId);
      return;
    }
    try {
      const conf = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      if (conf.encrypted === true || conf.encrypted === "true") encryptedBoxes.add(info.boxId);
      if (typeof conf.name === "string" && conf.name.trim()) boxNames.set(info.boxId, conf.name.trim());
    } catch {
      encryptedBoxes.add(info.boxId);
    }
  });

  const current: Record<string, OfficialCursorFile> = {};
  const etags: Record<string, string> = {};
  for (const { meta, info } of classified) {
    if (info.kind !== "doc" && info.kind !== "asset") continue;
    if (encryptedBoxes.has(info.boxId)) continue;
    const etag = meta.id || String(meta.updated ?? info.sourceId);
    current[info.sourceId] = { id: meta.id, path: displayRepoPath(info, boxNames), chunks: meta.chunks ?? [], updated: meta.updated };
    etags[info.sourceId] = etag;
  }

  const changes: Change[] = [];
  for (const [id, file] of Object.entries(current)) {
    const etag = etags[id];
    if (prevEtags[id] && prevEtags[id] === etag) continue;
    changes.push({ type: "upsert", source_id: id, path: file.path, etag, chunk_count: (file.chunks ?? []).length });
  }
  for (const id of Object.keys(prevEtags)) {
    if (!current[id]) changes.push({ type: "delete", source_id: id });
  }
  return {
    changes,
    nextCursor: { etags, files: current, indexId: index.id, repoRoot, boxNames: Object.fromEntries(boxNames) },
  };
}

function titleFromSy(raw: string, fallback: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const props = (parsed.Properties ?? parsed.properties ?? {}) as Record<string, unknown>;
    if (typeof props.title === "string" && props.title) return props.title;
    return fallback;
  } catch {
    return null;
  }
}

async function loadOfficialFiles(
  store: ByteStore,
  repoRoot: string,
  aesKey: Buffer,
): Promise<{ files: Record<string, OfficialCursorFile>; boxNames: Record<string, string> }> {
  const index = await loadLatestIndex(store, repoRoot);
  if (!verifyAesKey(index.aesKeyVerifyVal, aesKey)) {
    throw new HubError(SIYUAN_REPO_PASSWORD_INCORRECT_CODE, SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE, 400);
  }
  const metas = await mapPool(index.files ?? [], 8, (id) => getFileMeta(store, repoRoot, id, aesKey));
  const boxNames: Record<string, string> = {};
  const files: Record<string, OfficialCursorFile> = {};
  const classified: { meta: DejavuFile; info: ClassifiedRepoPath }[] = [];
  for (const meta of metas) {
    if (!meta?.path) continue;
    classified.push({ meta, info: classifyRepoFilePath(meta.path) });
  }
  for (const { meta, info } of classified) {
    if (info.kind === "conf") {
      const body = await assembleFile(store, repoRoot, meta, aesKey);
      if (!body) continue;
      try {
        const conf = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        if (typeof conf.name === "string" && conf.name.trim()) boxNames[info.boxId] = conf.name.trim();
      } catch {
        /* ignore */
      }
    }
  }
  for (const { meta, info } of classified) {
    if (info.kind !== "doc" && info.kind !== "asset") continue;
    files[info.sourceId] = { id: meta.id, path: displayRepoPath(info, boxNames), chunks: meta.chunks ?? [], updated: meta.updated };
  }
  return { files, boxNames };
}

function underAssets(path: string): boolean {
  return /(?:^|\/)assets\//.test(path);
}

export function findAssetFile(
  files: Record<string, OfficialCursorFile> | undefined,
  ref: string,
): OfficialCursorFile | undefined {
  if (!files) return undefined;
  const needle = posixVaultPath(ref).replace(/^\.\//, "");
  if (!needle) return undefined;
  const entries = Object.entries(files);

  const pick = (hits: [string, OfficialCursorFile][]): OfficialCursorFile | undefined => {
    if (!hits.length) return undefined;
    if (hits.length === 1) return hits[0][1];
    const prefer = hits.find(([, f]) => underAssets(posixVaultPath(f.path)));
    return (prefer ?? hits[0])[1];
  };

  if (files[needle]) return files[needle];
  const exact = entries.filter(([id, f]) => {
    const p = posixVaultPath(f.path);
    return id === needle || p === needle || id.endsWith(":" + needle);
  });
  const exactHit = pick(exact);
  if (exactHit) return exactHit;

  const assetIdx = needle.toLowerCase().indexOf("assets/");
  const assetTail = assetIdx >= 0 ? needle.slice(assetIdx) : "";
  const tails = [needle];
  if (assetTail && assetTail !== needle) tails.push(assetTail);
  const suffixHits = entries.filter(([id, f]) => {
    const p = posixVaultPath(f.path);
    return tails.some((t) => p === t || p.endsWith("/" + t) || id.endsWith(":" + t));
  });
  const suffixHit = pick(suffixHits);
  if (suffixHit) return suffixHit;

  const base = needle.split("/").pop() || needle;
  const byBase = entries.filter(([, f]) => posixVaultPath(f.path).split("/").pop() === base);
  return pick(byBase);
}

export async function fetchOfficialAsset(
  store: ByteStore,
  secrets: ConnectionSecrets | null | undefined,
  prefix: string,
  ref: string,
  cursor: OfficialCursor | Record<string, unknown> | null | undefined,
): Promise<Uint8Array> {
  const password = requirePassword(secrets);
  const aesKey = deriveRepoAesKey(password);
  const cur = (cursor ?? {}) as Partial<OfficialCursor>;
  let repoRoot = cur.repoRoot || "";
  let files = cur.files;
  if (!files || !Object.keys(files).length) {
    repoRoot = repoRoot || (await resolveRepoRoot(store, prefix));
    files = (await loadOfficialFiles(store, repoRoot, aesKey)).files;
  }
  const file = findAssetFile(files, ref);
  if (!file) return new Uint8Array();
  repoRoot = repoRoot || (await resolveRepoRoot(store, prefix));
  const body = await assembleFile(store, repoRoot, { id: file.id, path: file.path, chunks: file.chunks }, aesKey);
  return body ?? new Uint8Array();
}


function isoFromUnix(n?: number): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function sourceUpdatedFromSy(raw: string, fileUpdated?: number): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const props = (parsed.Properties ?? parsed.properties ?? {}) as Record<string, unknown>;
    const fromProps = parseSiyuanUpdated(props.updated) ?? parseSiyuanUpdated(parsed.updated);
    if (fromProps) return fromProps.toISOString();
  } catch {
    /* not json */
  }
  return isoFromUnix(fileUpdated);
}

export async function fetchOfficialNote(
  store: ByteStore,
  secrets: ConnectionSecrets | null | undefined,
  prefix: string,
  sourceId: string,
  cursor: OfficialCursor | Record<string, unknown> | null | undefined,
): Promise<NotePayload | null> {
  const password = requirePassword(secrets);
  const aesKey = deriveRepoAesKey(password);
  const cur = (cursor ?? {}) as Partial<OfficialCursor>;
  let file = cur.files?.[sourceId];
  let repoRoot = cur.repoRoot || "";
  let files = cur.files;
  if (!file) {
    repoRoot = repoRoot || (await resolveRepoRoot(store, prefix));
    const loaded = await loadOfficialFiles(store, repoRoot, aesKey);
    files = loaded.files;
    file = loaded.files[sourceId];
  }
  if (!file) return null;
  repoRoot = repoRoot || (await resolveRepoRoot(store, prefix));
  const body = await assembleFile(store, repoRoot, { id: file.id, path: file.path, chunks: file.chunks }, aesKey);
  if (!body) return null;
  if (sourceId.startsWith("asset:") || classifyRepoFilePath(file.path).kind === "asset") {
    const name = posixVaultPath(file.path).split("/").pop() || sourceId;
    return {
      source_id: sourceId,
      path: file.path,
      title: name,
      raw: "",
      kind: "asset",
      etag: file.id,
      source_updated_at: isoFromUnix(file.updated),
      assets: [{ path: name, bytes: body }],
    };
  }
  const raw = body.toString("utf8");
  const title = titleFromSy(raw, sourceId);
  if (title == null) return null;
  const assets: NotePayload["assets"] = [];
  const seen = new Set<string>();
  for (const ref of collectAssetRefs(raw)) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const hit = findAssetFile(files, ref);
    if (!hit) continue;
    const bytes = await assembleFile(store, repoRoot, { id: hit.id, path: hit.path, chunks: hit.chunks }, aesKey);
    if (bytes?.byteLength) assets.push({ path: ref, bytes });
  }
  return { source_id: sourceId, path: file.path, title, raw, etag: file.id, source_updated_at: sourceUpdatedFromSy(raw, file.updated), assets };
}

export function isOfficialCursor(cursor: Record<string, unknown> | null | undefined): boolean {
  if (!cursor) return false;
  if (typeof cursor.repoRoot === "string" && cursor.repoRoot) return true;
  const files = cursor.files;
  return Boolean(files && typeof files === "object" && !Array.isArray(files) && Object.keys(files).length);
}
