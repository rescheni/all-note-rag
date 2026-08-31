import {
  isMarkdownPath,
  obsidianSourceId,
  posixVaultPath,
  shouldIgnore,
  type ConnectionRecord,
} from "@note-hub/core";

const BOX_RE = /^(\d{14}-[0-9a-z]+)$/i;

export function decodeObjectKey(key: string): string {
  const s = String(key).replace(/\+/g, " ");
  try {
    return posixVaultPath(decodeURIComponent(s));
  } catch {
    return posixVaultPath(s);
  }
}

export function connectionPrefix(conn: ConnectionRecord): string {
  const cfg = conn.config ?? {};
  if (conn.source === "siyuan") {
    return posixVaultPath(cfg.workspace_prefix ?? cfg.remote_prefix ?? "").replace(/\/+$/, "");
  }
  return posixVaultPath(cfg.remote_prefix ?? "").replace(/\/+$/, "");
}

/** Vault/workspace-relative path. Accepts full object keys or already-relative paths. */
export function vaultRelFromKey(conn: ConnectionRecord, key: string): string {
  const k = decodeObjectKey(key);
  const prefix = connectionPrefix(conn);
  if (prefix && (k === prefix || k.startsWith(prefix + "/"))) {
    return k.slice(prefix.length).replace(/^\/+/, "");
  }
  return k;
}

export function keyUnderPrefix(key: string, prefix: string): boolean {
  const k = decodeObjectKey(key);
  const p = posixVaultPath(prefix ?? "").replace(/\/+$/, "");
  if (!p) return true;
  return k === p || k.startsWith(p + "/");
}

export type ObjectMatch = { rel: string; via: "source" | "hub"; objectKey: string };

export function connectionOwnsObject(
  conn: ConnectionRecord,
  bucket: string,
  key: string,
  hubBucket?: string,
): ObjectMatch | null {
  const k = decodeObjectKey(key);
  const cfg = conn.config ?? {};
  const b = cfg.bucket ?? "";
  if (b && b === bucket) {
    const prefix = connectionPrefix(conn);
    if (keyUnderPrefix(k, prefix)) {
      const rel = vaultRelFromKey(conn, k);
      if (rel) return { rel, via: "source", objectKey: k };
    }
  }
  if (hubBucket && bucket === hubBucket) {
    const m = /^source\/([^/]+)\/([^/]+)\/(.+)$/.exec(k);
    if (m && m[1] === conn.space_id && m[2] === conn.id) {
      return { rel: m[3], via: "hub", objectKey: k };
    }
  }
  return null;
}

export type MappedObjectKey = {
  source_id: string;
  path: string;
  kind: "note" | "asset" | "skip";
  objectKey: string;
  boxId?: string;
  reason?: string;
};

function mapObsidian(conn: ConnectionRecord, rel: string, objectKey: string): MappedObjectKey {
  if (shouldIgnore(rel, conn.config.ignore)) {
    return { source_id: obsidianSourceId(conn.id, rel), path: rel, kind: "skip", objectKey, reason: "ignore" };
  }
  const source_id = obsidianSourceId(conn.id, rel);
  if (isMarkdownPath(rel)) return { source_id, path: rel, kind: "note", objectKey };
  return { source_id, path: rel, kind: "asset", objectKey };
}

export function parseSiyuanWorkspaceRel(rel: string): {
  boxId: string;
  sourceId: string;
  kind: "note" | "asset" | "skip";
  reason?: string;
} | null {
  const r = posixVaultPath(rel);
  if (!r || r.endsWith("/")) return null;
  if (r.startsWith("temp/") || r.split("/").includes("temp")) {
    return { boxId: "", sourceId: "", kind: "skip", reason: "temp" };
  }
  if (!r.endsWith(".sy")) {
    if (r.includes("/assets/") || r.startsWith("assets/")) {
      const parts = r.split("/");
      const dataIdx = parts.indexOf("data");
      const boxId = dataIdx >= 0 ? parts[dataIdx + 1] ?? "" : "";
      return { boxId, sourceId: r, kind: "asset" };
    }
    return { boxId: "", sourceId: r, kind: "asset" };
  }
  const parts = r.split("/");
  const dataIdx = parts.indexOf("data");
  if (dataIdx < 0 || parts.length < dataIdx + 3) {
    return { boxId: "", sourceId: "", kind: "skip", reason: "not-doc" };
  }
  const boxId = parts[dataIdx + 1];
  if (!BOX_RE.test(boxId)) return { boxId, sourceId: "", kind: "skip", reason: "box" };
  if (parts[dataIdx + 2] === "assets") return { boxId, sourceId: r, kind: "asset" };
  const file = parts[parts.length - 1];
  const sourceId = file.replace(/\.sy$/i, "");
  return { boxId, sourceId, kind: "note" };
}

function mapSiyuan(conn: ConnectionRecord, rel: string, objectKey: string): MappedObjectKey {
  const mode = conn.mode || conn.config?.mode || "api";
  if (mode !== "workspace") {
    return { source_id: rel, path: rel, kind: "note", objectKey };
  }
  const parsed = parseSiyuanWorkspaceRel(rel);
  if (!parsed) return { source_id: rel, path: rel, kind: "skip", objectKey, reason: "empty" };
  if (parsed.kind === "skip") {
    return { source_id: parsed.sourceId || rel, path: rel, kind: "skip", objectKey, boxId: parsed.boxId, reason: parsed.reason };
  }
  return {
    source_id: parsed.sourceId,
    path: rel,
    kind: parsed.kind,
    objectKey,
    boxId: parsed.boxId,
  };
}

export function mapConnectionObjectKey(conn: ConnectionRecord, key: string): MappedObjectKey | null {
  const k = decodeObjectKey(key);
  if (!k) return null;
  const rel = vaultRelFromKey(conn, k);
  if (!rel) return null;
  if (conn.source === "obsidian") return mapObsidian(conn, rel, k);
  if (conn.source === "siyuan") return mapSiyuan(conn, rel, k);
  return { source_id: rel, path: rel, kind: "note", objectKey: k };
}

export function siyuanBoxConfRel(boxId: string): string {
  return `data/${boxId}/.siyuan/conf.json`;
}
