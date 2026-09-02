import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.ts";

export const hubS3 = new S3Client({
  region: env.s3Region,
  endpoint: env.s3Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
});

export async function putHub(key: string, body: string | Uint8Array, contentType?: string) {
  await hubS3.send(
    new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getHub(key: string): Promise<Uint8Array | null> {
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
