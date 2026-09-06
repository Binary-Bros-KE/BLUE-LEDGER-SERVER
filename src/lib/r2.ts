import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { env } from "../env.js";
import { HttpError } from "./http-error.js";

/**
 * Cloudflare R2 (S3-compatible) object storage for product photos — see
 * ECOMMERCE-ARCHITECTURE.md §8. One shared bucket for every tenant, keyed
 * `tenants/<tenantId>/products/<productId>/<uuid>.webp`.
 *
 * The raw upload is NEVER stored: on ingest it's re-encoded to two WebP derivatives (a ~1500px
 * "full" and a ~400px thumbnail), which is what makes the storage bill effectively zero at this
 * scale. The 5 MB limit below is an *upload* cap, not a storage figure.
 *
 * All four env vars are optional so the server boots without them. Until they're set,
 * `isR2Configured()` is false and the upload route returns 501 — the feature ships dark and
 * lights up the moment the credentials land on the VPS `.env`.
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CACHE_FOREVER = "public, max-age=31536000, immutable";

type R2Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  bucket: string;
};

function resolveConfig(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL, R2_BUCKET, R2_ENDPOINT } =
    env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
    return null;
  }
  // Accept a full "S3 API" string with the bucket path appended (that's how the Cloudflare UI shows
  // it) and strip it back to a bare origin.
  const endpoint = (R2_ENDPOINT?.trim() || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
    .replace(/\/+$/, "")
    .replace(new RegExp(`/${R2_BUCKET}$`), "");
  return {
    endpoint,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    publicBaseUrl: R2_PUBLIC_BASE_URL.replace(/\/+$/, ""),
    bucket: R2_BUCKET,
  };
}

export function isR2Configured(): boolean {
  return resolveConfig() !== null;
}

let cachedClient: S3Client | null = null;

function requireConfig(): R2Config {
  const config = resolveConfig();
  if (!config) {
    throw new HttpError(
      501,
      "Image uploads aren't set up on this server yet — the Cloudflare R2 credentials are missing.",
      "R2_NOT_CONFIGURED",
    );
  }
  return config;
}

function client(config: R2Config): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Cloudflare R2 does not accept the AWS SDK's newer default flexible-checksum trailers
      // (STREAMING-UNSIGNED-PAYLOAD-TRAILER + aws-chunked) — the signed request is rejected with a
      // bare 403 AccessDenied. Pin both back to "only when the operation requires it", which is how
      // every R2 guide configures the v3 SDK.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      // Path-style addressing (endpoint/bucket/key) — the long-standing R2-recommended setting;
      // avoids any per-bucket vhost DNS/TLS edge case.
      forcePathStyle: true,
    });
  }
  return cachedClient;
}

export type UploadedImage = { url: string; thumbUrl: string };

/** Validate → re-encode to WebP (full + thumb) → PutObject both. Returns the two public URLs. */
export async function uploadProductImage(
  tenantId: string,
  productId: string,
  raw: Buffer,
): Promise<UploadedImage> {
  const config = requireConfig();

  if (raw.byteLength === 0) throw new HttpError(400, "The uploaded file is empty");
  if (raw.byteLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "That image is larger than 5 MB — please pick a smaller file.");
  }

  let full: Buffer;
  let thumb: Buffer;
  try {
    // .rotate() with no args bakes in the EXIF orientation so portrait phone photos aren't sideways.
    const source = sharp(raw, { failOn: "error" }).rotate();
    [full, thumb] = await Promise.all([
      source.clone().resize(1500, 1500, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
      source.clone().resize(400, 400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer(),
    ]);
  } catch {
    throw new HttpError(415, "That file doesn't look like a readable image.");
  }

  const s3 = client(config);
  const id = randomUUID();
  const prefix = `tenants/${tenantId}/products/${productId}`;
  const key = `${prefix}/${id}.webp`;
  const thumbKey = `${prefix}/${id}_thumb.webp`;

  try {
    await Promise.all([
      s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: full,
          ContentType: "image/webp",
          CacheControl: CACHE_FOREVER,
        }),
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: thumbKey,
          Body: thumb,
          ContentType: "image/webp",
          CacheControl: CACHE_FOREVER,
        }),
      ),
    ]);
  } catch (err) {
    // Surface the real R2 reason to the operator instead of a bare 500. The overwhelmingly common
    // one is a 403 "AccessDenied" from a bucket-scoped "Object Read & Write" token — R2 requires an
    // "Admin Read & Write" token for S3 PutObject (a known Cloudflare limitation).
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    const code = e.Code ?? e.name ?? "UploadError";
    const status = e.$metadata?.httpStatusCode;
    console.error("[r2] PutObject failed:", err);
    throw new HttpError(
      502,
      status === 403 || code === "AccessDenied"
        ? "Cloudflare R2 rejected the upload (AccessDenied). The R2 API token needs “Admin Read & Write” permission — an “Object Read & Write” token can’t write via the S3 API."
        : `Cloudflare R2 rejected the upload (${code}${status ? ` ${status}` : ""}).`,
      "R2_UPLOAD_FAILED",
    );
  }

  return { url: `${config.publicBaseUrl}/${key}`, thumbUrl: `${config.publicBaseUrl}/${thumbKey}` };
}

/** Best-effort delete of an image pair given the "full" public URL. An orphaned object costs a
 * fraction of a cent, so any failure here is swallowed — a periodic sweep can reconcile. */
export async function deleteProductImage(url: string): Promise<void> {
  const config = resolveConfig();
  if (!config) return;
  const prefixUrl = `${config.publicBaseUrl}/`;
  if (!url.startsWith(prefixUrl)) return;

  const key = url.slice(prefixUrl.length);
  const thumbKey = key.replace(/\.webp$/, "_thumb.webp");
  const s3 = client(config);
  await Promise.allSettled([
    s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })),
    s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: thumbKey })),
  ]);
}
