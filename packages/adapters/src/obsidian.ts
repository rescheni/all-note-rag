import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import {
  DEFAULT_OBSIDIAN_IGNORE,
  isMarkdownPath,
  obsidianSourceId,
  posixVaultPath,
  shouldIgnore,
  stripPrefix,
  titleFromPath,
  type Adapter,
  type AdapterContext,
  type Change,
  type NotePayload,
  type ProbeResult,
} from "@note-hub/core";
import { referencedAssetPaths } from "@note-hub/normalize";

export type CursorEtags = {
  etags: Record<string, string>;
};

function ignoreList(ctx: AdapterContext): string[] {
  const extra = ctx.connection.config.ignore ?? [];
  return [...new Set([...DEFAULT_OBSIDIAN_IGNORE, ...extra])];
}

export function createS3Client(ctx: AdapterContext): S3Client {
  const cfg = ctx.connection.config;
  const secrets = ctx.secrets;
  return new S3Client({
    region: cfg.region || "us-east-1",
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.force_path_style !== false,
    credentials: secrets
      ? { accessKeyId: secrets.access_key, secretAccessKey: secrets.secret_key }
      : undefined,
  });
}

async function listAll(client: S3Client, bucket: string, prefix: string): Promise<_Object[]> {
  const out: _Object[] = [];
  let token: string | undefined;
  const pfx = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx || undefined,
        ContinuationToken: token,
      }),
    );
    out.push(...(resp.Contents ?? []));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function relOf(key: string, prefix: string): string {
  return stripPrefix(key, prefix);
}

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof b.transformToByteArray === "function") return b.transformToByteArray();
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export class ObsidianAdapter implements Adapter {
  constructor(private readonly client?: S3Client) {}

  private s3(ctx: AdapterContext): S3Client {
    return this.client ?? createS3Client(ctx);
  }

  async probe(ctx: AdapterContext): Promise<ProbeResult> {
    if (ctx.connection.config.e2ee) {
      return {
        ok: false,
        status: "encrypted_unreadable",
        message: "Obsidian E2EE is enabled; bodies will not be ingested",
      };
    }
    const cfg = ctx.connection.config;
    try {
      await this.s3(ctx).send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      await this.s3(ctx).send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: cfg.remote_prefix ? posixVaultPath(cfg.remote_prefix) + "/" : undefined,
          MaxKeys: 1,
        }),
      );
      return { ok: true, status: "active" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: "error", message };
    }
  }

  async listChanges(ctx: AdapterContext): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }> {
    const cfg = ctx.connection.config;
    const prefix = posixVaultPath(cfg.remote_prefix ?? "");
    const ignore = ignoreList(ctx);
    const objects = await listAll(this.s3(ctx), cfg.bucket, prefix);
    const current: Record<string, { etag: string; key: string }> = {};
    for (const obj of objects) {
      if (!obj.Key) continue;
      const rel = relOf(obj.Key, prefix);
      if (!rel || rel.endsWith("/")) continue;
      if (shouldIgnore(rel, ignore)) continue;
      current[rel] = { etag: (obj.ETag ?? "").replaceAll('"', ""), key: obj.Key };
    }

    const prev = ((ctx.cursor ?? {}) as CursorEtags).etags ?? {};
    const changes: Change[] = [];

    const mdRels = Object.keys(current).filter(isMarkdownPath);
    const mdBodies = new Map<string, string>();
    for (const rel of mdRels) {
      const prevEtag = prev[rel];
      const etag = current[rel].etag;
      if (prevEtag && prevEtag === etag) {
        /* still need body to discover referenced assets on first... if cursor has it, skip fetch */
      } else {
        changes.push({
          type: "upsert",
          source_id: obsidianSourceId(ctx.connection.id, rel),
          path: rel,
          etag,
        });
      }
    }

    const referenced = new Set<string>();
    const needScan = mdRels.filter((rel) => !prev[rel] || prev[rel] !== current[rel].etag || Object.keys(prev).length === 0);
    const scanList = Object.keys(prev).length === 0 ? mdRels : needScan;
    for (const rel of scanList) {
      try {
        const bytes = await this.getKey(ctx, current[rel].key);
        const text = new TextDecoder().decode(bytes);
        mdBodies.set(rel, text);
        for (const p of referencedAssetPaths(text, rel)) {
          const candidates = [p, posixVaultPath(p)];
          for (const c of candidates) {
            if (current[c]) referenced.add(c);
          }
        }
      } catch {
        /* listed change still stands */
      }
    }
    if (Object.keys(prev).length === 0) {
      // first sync: md already queued; add referenced binaries
    } else {
      /* incremental: also upsert md already added */
    }

    for (const rel of referenced) {
      if (isMarkdownPath(rel)) continue;
      const etag = current[rel]?.etag;
      if (!etag) continue;
      if (prev[rel] && prev[rel] === etag) continue;
      changes.push({
        type: "upsert",
        source_id: obsidianSourceId(ctx.connection.id, rel),
        path: rel,
        etag,
      });
    }

    // On first sync, if md wasn't added because etag match (empty prev never matches), good.
    // Ensure first-sync md upserts exist even if we skipped due to identical... empty prev is fine.

    for (const rel of Object.keys(prev)) {
      if (!current[rel]) {
        changes.push({
          type: "delete",
          source_id: obsidianSourceId(ctx.connection.id, rel),
          path: rel,
        });
      } else if (isMarkdownPath(rel) && prev[rel] !== current[rel].etag) {
        /* already added */
      }
    }

    // Unchanged md files should not appear. First listing: all md + referenced png.
    const nextEtags: Record<string, string> = {};
    for (const [rel, v] of Object.entries(current)) {
      if (isMarkdownPath(rel) || referenced.has(rel) || prev[rel]) {
        nextEtags[rel] = v.etag;
      }
    }

    void mdBodies;
    return { changes, nextCursor: { etags: nextEtags } };
  }

  async fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null> {
    const prefix = posixVaultPath(ctx.connection.config.remote_prefix ?? "");
    const path = source_id.replace(new RegExp(`^obsidian://${ctx.connection.id}/`), "");
    if (!path || path === source_id) return null;
    const key = prefix ? `${prefix}/${path}` : path;
    try {
      const bytes = await this.getKey(ctx, key);
      const raw = new TextDecoder().decode(bytes);
      const assets: NotePayload["assets"] = [];
      if (isMarkdownPath(path)) {
        for (const rel of referencedAssetPaths(raw, path)) {
          const aPrefix = prefix ? `${prefix}/${rel}` : rel;
          try {
            const ab = await this.getKey(ctx, aPrefix);
            assets.push({ path: rel, bytes: ab });
          } catch {
            /* missing attachment is not fatal */
          }
        }
      }
      return {
        source_id,
        path,
        title: titleFromPath(path),
        raw,
        assets,
      };
    } catch {
      return null;
    }
  }

  async fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array> {
    const prefix = posixVaultPath(ctx.connection.config.remote_prefix ?? "");
    const rel = posixVaultPath(ref);
    const key = prefix ? `${prefix}/${rel}` : rel;
    return this.getKey(ctx, key);
  }

  private async getKey(ctx: AdapterContext, key: string): Promise<Uint8Array> {
    const resp = await this.s3(ctx).send(
      new GetObjectCommand({ Bucket: ctx.connection.config.bucket, Key: key }),
    );
    return streamToBytes(resp.Body);
  }
}

export { shouldIgnore, stripPrefix };
