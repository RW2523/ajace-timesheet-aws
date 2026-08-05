// S3 file storage.
// Keys mirror the app's existing layout: ts-uploads/{userId}/{YYYY-MM}/{ts}.{ext}
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.STORAGE_S3_REGION || "us-east-1";
const BUCKET = process.env.STORAGE_S3_BUCKET;
// Credentials come from the EC2 instance IAM role (default provider chain).
// requestChecksumCalculation:"WHEN_REQUIRED" stops the SDK from baking a CRC32
// checksum into presigned PUT URLs — that checksum is computed without the body
// at signing time, so the browser's real upload would never match it (403/400).
// STORAGE_S3_ENDPOINT points the client at an S3-COMPATIBLE server instead of
// AWS — MinIO in a container, for running the app on a laptop or a dev box with
// no AWS account. It is unset in production, where the default endpoint and the
// EC2 instance role are exactly what we want.
//
// forcePathStyle is not optional when the endpoint is overridden: the SDK
// otherwise addresses the bucket as a subdomain (bucket.host), which MinIO does
// not serve unless it has been given a domain. Path style (host/bucket) is what
// every S3-compatible server accepts.
const ENDPOINT = process.env.STORAGE_S3_ENDPOINT || undefined;
const s3 = new S3Client({
  region: REGION,
  requestChecksumCalculation: "WHEN_REQUIRED",
  ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
});

// Key prefix for every uploaded document.
export const PREFIX = "ts-uploads";
export const keyFor = (path) => `${PREFIX}/${path}`; // path = {userId}/{YYYY-MM}/{ts}.ext

export async function signedGetUrl(path, expiresIn = 120) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(path) }), { expiresIn });
}
// NOTE: there is deliberately no presigned-PUT helper. Uploads are proxied
// through /api/storage/upload so the browser never talks to S3 directly — that
// is what removes the need for bucket CORS entirely.
export async function putObject(path, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: keyFor(path), Body: body,
    ContentType: contentType || "application/octet-stream",
  }));
  return path;
}
export async function getObjectBytes(path) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(path) }));
  const bytes = Buffer.from(await out.Body.transformToByteArray());
  return { bytes, contentType: out.ContentType || "application/octet-stream" };
}
export async function deleteObjects(paths) {
  await Promise.all(
    paths.map((p) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(p) })))
  );
}
