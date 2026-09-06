import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env.ts";

export const hubS3 = new S3Client({
  region: env.s3Region,
  endpoint: env.s3Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
});

export async function ensureBucket(bucket: string): Promise<void> {
  try {
    await hubS3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await hubS3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putObject(key: string, body: string | Uint8Array, contentType?: string): Promise<void> {
  await hubS3.send(
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBytes(key: string): Promise<Uint8Array | null> {
  try {
    const resp = await hubS3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    if (!resp.Body) return null;
    if (typeof resp.Body.transformToByteArray === "function") return resp.Body.transformToByteArray();
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

export async function getObjectText(key: string): Promise<string | null> {
  const b = await getObjectBytes(key);
  return b ? new TextDecoder().decode(b) : null;
}

/** Objects per DeleteObjects call (S3 / MinIO hard limit is 1000). */
const DELETE_BATCH = 1000;

/**
 * Batch-delete objects from the hub bucket. Never throws: a partial failure is
 * reported in `failed` so callers (e.g. deleting a connection) can log and move on.
 */
export async function deleteHubObjects(keys: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    try {
      const res = await hubS3.send(
        new DeleteObjectsCommand({
          Bucket: env.s3Bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const errs = res.Errors?.length ?? 0;
      failed += errs;
      deleted += batch.length - errs;
    } catch {
      failed += batch.length;
    }
  }
  return { deleted, failed };
}
