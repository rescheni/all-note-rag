import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
