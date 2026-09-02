import { describe, expect, it } from "vitest";
import {
  HubError,
  SIYUAN_REPO_PASSWORD_INCORRECT_CODE,
  SIYUAN_REPO_PASSWORD_REQUIRED_CODE,
  type AdapterContext,
} from "@note-hub/core";
import { memoryStore, SiYuanAdapter } from "../src/siyuan.ts";
import {
  aesDecrypt,
  aesEncrypt,
  buildAesKeyVerifyVal,
  classifyRepoFilePath,
  findAssetFile,
  deriveRepoAesKey,
  decodeObject,
  encodeObject,
  verifyAesKey,
  zstdCompress,
  zstdDecompressBytes,
} from "../src/siyuan-dejavu.ts";

function ctx(partial: Partial<AdapterContext["connection"]> & { config?: AdapterContext["connection"]["config"]; secrets?: AdapterContext["secrets"] }): AdapterContext {
  return {
    connection: {
      id: "conn_sy",
      space_id: "space_sy",
      source: "siyuan",
      name: "fixture",
      config: partial.config ?? {},
      secrets_ref: null,
      cursor: null,
      mode: partial.mode ?? "workspace",
      status: "active",
      last_sync_at: null,
      last_error: null,
      ...partial,
    },
    secrets: partial.secrets ?? { access_key: "minioadmin", secret_key: "minioadmin" },
    cursor: null,
  };
}

const BOX = "20200813053000-boxdemo";
const DOC_ID = "20200813053012-parent0";
const ENC_BOX = "20200813055999-encnote";
const ENC_DOC = "20200813056000-cipher";
const PASS = "hub-test-repo-passphrase";
const INDEX_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FILE_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHUNK_ID = "cccccccccccccccccccccccccccccccccccccccc";
const CONF_ID = "dddddddddddddddddddddddddddddddddddddddd";
const CONF_CHUNK = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ENC_FILE_ID = "ffffffffffffffffffffffffffffffffffffffff";
const ENC_CHUNK = "1111111111111111111111111111111111111111";
const ENC_CONF_ID = "2222222222222222222222222222222222222222";
const ENC_CONF_CHUNK = "3333333333333333333333333333333333333333";

const SY_JSON = JSON.stringify({
  ID: DOC_ID,
  Type: "NodeDocument",
  Properties: { id: DOC_ID, title: "欢迎仓库" },
  Children: [{ Type: "NodeParagraph", ID: "p1", Children: [{ Type: "NodeText", Data: "官方快照" }] }],
});

function objKey(id: string): string {
  return `repo/objects/${id.slice(0, 2)}/${id.slice(2)}`;
}

function buildRepo(passphrase: string, opts?: { badVerify?: boolean; emptyVerify?: boolean; extraFiles?: Record<string, Uint8Array> }): Record<string, Uint8Array> {
  const key = deriveRepoAesKey(passphrase);
  const syBytes = Buffer.from(SY_JSON, "utf8");
  const confBytes = Buffer.from(JSON.stringify({ name: "演示笔记本", closed: false }), "utf8");
  const encConf = Buffer.from(JSON.stringify({ name: "加密笔记本", encrypted: true }), "utf8");
  const encSy = Buffer.from("not-json-cipher", "utf8");
  const index = {
    id: INDEX_ID,
    memo: "test",
    created: 1_700_000_000_000,
    files: [FILE_ID, CONF_ID, ENC_FILE_ID, ENC_CONF_ID],
    count: 4,
    size: syBytes.length,
    aesKeyVerifyVal: opts?.emptyVerify ? "" : opts?.badVerify ? buildAesKeyVerifyVal(deriveRepoAesKey("wrong-password")) : buildAesKeyVerifyVal(key),
  };
  const fileMeta = {
    id: FILE_ID,
    path: `/${BOX}/${DOC_ID}.sy`,
    size: syBytes.length,
    updated: 1_700_000_000_000,
    chunks: [CHUNK_ID],
  };
  const confMeta = {
    id: CONF_ID,
    path: `/${BOX}/.siyuan/conf.json`,
    size: confBytes.length,
    updated: 1_700_000_000_000,
    chunks: [CONF_CHUNK],
  };
  const encFileMeta = {
    id: ENC_FILE_ID,
    path: `/${ENC_BOX}/${ENC_DOC}.sy`,
    size: encSy.length,
    updated: 1_700_000_000_000,
    chunks: [ENC_CHUNK],
  };
  const encConfMeta = {
    id: ENC_CONF_ID,
    path: `/${ENC_BOX}/.siyuan/conf.json`,
    size: encConf.length,
    updated: 1_700_000_000_000,
    chunks: [ENC_CONF_CHUNK],
  };
  const indexesV2 = { indexes: [{ id: INDEX_ID, created: 1_700_000_000_000 }] };
  return {
    "repo/indexes-v2.json": zstdCompress(Buffer.from(JSON.stringify(indexesV2), "utf8")),
    "repo/refs/latest": Buffer.from(INDEX_ID + "\n", "utf8"),
    [`repo/indexes/${INDEX_ID}`]: zstdCompress(Buffer.from(JSON.stringify(index), "utf8")),
    [objKey(FILE_ID)]: encodeObject(Buffer.from(JSON.stringify(fileMeta), "utf8"), key),
    [objKey(CHUNK_ID)]: encodeObject(syBytes, key),
    [objKey(CONF_ID)]: encodeObject(Buffer.from(JSON.stringify(confMeta), "utf8"), key),
    [objKey(CONF_CHUNK)]: encodeObject(confBytes, key),
    [objKey(ENC_FILE_ID)]: encodeObject(Buffer.from(JSON.stringify(encFileMeta), "utf8"), key),
    [objKey(ENC_CHUNK)]: encodeObject(encSy, key),
    [objKey(ENC_CONF_ID)]: encodeObject(Buffer.from(JSON.stringify(encConfMeta), "utf8"), key),
    [objKey(ENC_CONF_CHUNK)]: encodeObject(encConf, key),
    ...(opts?.extraFiles ?? {}),
  };
}

describe("repo key derivation", () => {
  it("uses a standard base64 32-byte payload as the AES key", () => {
    const raw = Buffer.alloc(32, 7);
    const pass = raw.toString("base64");
    expect(deriveRepoAesKey(pass).equals(raw)).toBe(true);
  });

  it("derives scrypt key for a normal passphrase", () => {
    const a = deriveRepoAesKey("not-a-base64-key");
    const b = deriveRepoAesKey("not-a-base64-key");
    const c = deriveRepoAesKey("different");
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("aes+zstd roundtrip", () => {
  it("encrypts then decrypts with prepended nonce", () => {
    const key = deriveRepoAesKey("roundtrip-pass");
    const plain = Buffer.from("hello-siyuan", "utf8");
    const enc = aesEncrypt(plain, key);
    expect(enc.length).toBeGreaterThanOrEqual(28);
    expect(aesDecrypt(enc, key).equals(plain)).toBe(true);
  });

  it("zstd then aes encodes object payloads", () => {
    const key = deriveRepoAesKey("object-pass");
    const plain = Buffer.from(JSON.stringify({ id: "x", path: "/a.sy", chunks: ["c"] }), "utf8");
    const packed = encodeObject(plain, key);
    expect(decodeObject(packed, key).equals(plain)).toBe(true);
    const rawZ = zstdCompress(plain);
    expect(zstdDecompressBytes(rawZ).equals(plain)).toBe(true);
  });

  it("verifies aesKeyVerifyVal and rejects a wrong key", () => {
    const key = deriveRepoAesKey("verify-pass");
    const val = buildAesKeyVerifyVal(key);
    expect(verifyAesKey(val, key)).toBe(true);
    expect(verifyAesKey(val, deriveRepoAesKey("other"))).toBe(false);
    expect(verifyAesKey("", key)).toBe(true);
  });
});

describe("classifyRepoFilePath", () => {
  it("accepts dejavu paths relative to data/", () => {
    const doc = classifyRepoFilePath(`/${BOX}/${DOC_ID}.sy`);
    expect(doc).toMatchObject({ kind: "doc", boxId: BOX, sourceId: DOC_ID });
    const conf = classifyRepoFilePath(`/${BOX}/.siyuan/conf.json`);
    expect(conf.kind).toBe("conf");
    const asset = classifyRepoFilePath(`/${BOX}/assets/x.png`);
    expect(asset.kind).toBe("asset");
    expect(asset.sourceId).toBe(`asset:${BOX}:assets/x.png`);
    expect(classifyRepoFilePath("/temp/x.sy").kind).toBe("skip");
  });

  it("classifies workspace-root assets", () => {
    const a = classifyRepoFilePath("assets/foo.png");
    expect(a).toMatchObject({ kind: "asset", boxId: "_", sourceId: "asset:_:assets/foo.png" });
    const b = classifyRepoFilePath("/data/assets/bar.jpg");
    expect(b.kind).toBe("asset");
    expect(b.sourceId).toBe("asset:_:assets/bar.jpg");
    const c = classifyRepoFilePath(`/${BOX}/shot.png`);
    expect(c.kind).toBe("asset");
    expect(c.sourceId).toBe(`asset:${BOX}:shot.png`);
    const d = classifyRepoFilePath(`/${BOX}/docs/file.pdf`);
    expect(d.kind).toBe("asset");
    expect(d.sourceId).toBe(`asset:${BOX}:docs/file.pdf`);
  });

  it("findAssetFile matches suffix and prefers assets/ on basename clash", () => {
    const files = {
      "asset:_:assets/foo.png": { id: "1", path: "assets/foo.png", chunks: ["c1"] },
      "asset:box:other/foo.png": { id: "2", path: "notebook/other/foo.png", chunks: ["c2"] },
    };
    expect(findAssetFile(files, "assets/foo.png")?.id).toBe("1");
    expect(findAssetFile(files, "foo.png")?.id).toBe("1");
    expect(findAssetFile(files, "other/foo.png")?.id).toBe("2");
  });
});

describe("siyuan official repo adapter", () => {
  it("requires 数据仓库密码 when the bucket is an official snapshot", async () => {
    const adapter = new SiYuanAdapter({ store: memoryStore(buildRepo(PASS)) });
    const c = ctx({ mode: "workspace", config: { bucket: "siyuan", workspace_prefix: "workspace" } });
    const probe = await adapter.probe(c);
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe(SIYUAN_REPO_PASSWORD_REQUIRED_CODE);
    expect(probe.message).toContain("数据仓库密码");
    await expect(adapter.listChanges(c)).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(HubError);
      expect((e as HubError).code).toBe(SIYUAN_REPO_PASSWORD_REQUIRED_CODE);
      return true;
    });
  });

  it("rejects a wrong password when aesKeyVerifyVal is empty by sampling a file", async () => {
    const adapter = new SiYuanAdapter({ store: memoryStore(buildRepo(PASS, { emptyVerify: true })) });
    const c = ctx({
      mode: "workspace",
      config: { bucket: "siyuan", workspace_prefix: "workspace" },
      secrets: { access_key: "ak", secret_key: "sk", repo_password: "nope" },
    });
    const probe = await adapter.probe(c);
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe(SIYUAN_REPO_PASSWORD_INCORRECT_CODE);
  });

  it("rejects an incorrect repo password", async () => {
    const adapter = new SiYuanAdapter({ store: memoryStore(buildRepo(PASS)) });
    const c = ctx({
      mode: "workspace",
      config: { bucket: "siyuan", workspace_prefix: "workspace", official_s3: true },
      secrets: { access_key: "ak", secret_key: "sk", repo_password: "nope" },
    });
    const probe = await adapter.probe(c);
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe(SIYUAN_REPO_PASSWORD_INCORRECT_CODE);
  });

  it("lists .sy docs from the latest snapshot and fetches decrypted JSON", async () => {
    const files = buildRepo(PASS);
    const adapter = new SiYuanAdapter({ store: memoryStore(files) });
    const c = ctx({
      mode: "workspace",
      config: { bucket: "siyuan", workspace_prefix: "workspace" },
      secrets: { access_key: "ak", secret_key: "sk", repo_password: PASS },
    });
    const probe = await adapter.probe(c);
    expect(probe.ok).toBe(true);
    const { changes, nextCursor } = await adapter.listChanges(c);
    expect(changes.map((x) => x.source_id).filter((id) => !id.startsWith("asset:")).sort()).toEqual([DOC_ID]);
    expect(changes.find((x) => x.source_id === DOC_ID)?.path).toBe(`演示笔记本/${DOC_ID}.sy`);
    expect(changes[0].etag).toBe(FILE_ID);
    expect(changes.some((x) => x.source_id === ENC_DOC)).toBe(false);
    const note = await adapter.fetchNote({ ...c, cursor: nextCursor }, DOC_ID);
    expect(note?.title).toBe("欢迎仓库");
    expect(String(note?.raw)).toContain("官方快照");
    const again = await adapter.listChanges({ ...c, cursor: nextCursor });
    expect(again.changes.filter((x) => x.type === "upsert")).toHaveLength(0);
  });
});
