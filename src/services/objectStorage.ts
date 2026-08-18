import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

/**
 * storageKey values often come from client-controlled data (a template's
 * headerMediaStorageKey, a media-gallery request body, etc.) with only a
 * workspace-prefix `startsWith` check upstream — that check alone doesn't
 * reject `..` segments, so `${workspaceId}/../other-workspace/x.jpg` would
 * still pass it. Resolve and verify the path stays inside UPLOADS_ROOT
 * before any local-disk read/write/delete, closing that traversal off at
 * the one place all callers funnel through.
 */
function resolveLocalPath(storageKey: string): string {
  const fullPath = path.join(UPLOADS_ROOT, storageKey);
  const resolvedRoot = path.resolve(UPLOADS_ROOT) + path.sep;
  const resolvedPath = path.resolve(fullPath);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error('Invalid storage key');
  }
  return resolvedPath;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: config.aws.region,
      followRegionRedirects: true,
      ...(config.aws.s3Endpoint ? { endpoint: config.aws.s3Endpoint } : {}),
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function objectKey(storageKey: string): string {
  const prefix = config.aws.s3Prefix;
  return prefix ? `${prefix}/${storageKey}` : storageKey;
}

export function isObjectStorageEnabled(): boolean {
  return config.aws.enabled;
}

/** Public (or endpoint-based) HTTPS URL for an object key. Bucket must allow access or use app proxy. */
export function publicObjectUrl(storageKey: string): string {
  const key = objectKey(storageKey);
  const endpoint = config.aws.s3Endpoint;
  if (endpoint) {
    // Custom endpoint may already include bucket host (e.g. https://bucket.s3.region.amazonaws.com)
    if (endpoint.includes(config.aws.bucketName)) {
      return `${endpoint}/${key}`;
    }
    return `${endpoint}/${config.aws.bucketName}/${key}`;
  }
  return `https://${config.aws.bucketName}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

export async function putObject(
  storageKey: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  if (isObjectStorageEnabled()) {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.aws.bucketName,
        Key: objectKey(storageKey),
        Body: buffer,
        ContentType: contentType,
      })
    );
    return;
  }

  const fullPath = resolveLocalPath(storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function getObject(storageKey: string): Promise<Buffer> {
  if (isObjectStorageEnabled()) {
    try {
      const response = await getS3Client().send(
        new GetObjectCommand({
          Bucket: config.aws.bucketName,
          Key: objectKey(storageKey),
        })
      );
      if (!response.Body) {
        throw new Error('Empty S3 object body');
      }
      return Buffer.from(await response.Body.transformToByteArray());
    } catch {
      // Fall through to local disk for keys written before S3 migration.
    }
  }

  return fs.readFile(resolveLocalPath(storageKey));
}

/**
 * Returns true if the object is confirmed gone (deleted now, or already
 * absent), false if deletion genuinely failed (permission error, network
 * failure, throttling, ...). Callers that need to know whether it's safe to
 * drop their own reference to this key (e.g. deleting a DB row that's the
 * only pointer to it) should check the return value instead of assuming
 * success — S3's DeleteObject is idempotent and rarely errors for a
 * missing key, so a caught error here is almost always a real failure, not
 * a harmless "already deleted."
 */
export async function deleteObject(storageKey: string): Promise<boolean> {
  let ok = true;

  if (isObjectStorageEnabled()) {
    try {
      await getS3Client().send(
        new DeleteObjectCommand({
          Bucket: config.aws.bucketName,
          Key: objectKey(storageKey),
        })
      );
    } catch (err) {
      console.error('[objectStorage] S3 delete failed', { storageKey, err });
      ok = false;
    }
  }

  try {
    await fs.unlink(resolveLocalPath(storageKey));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.error('[objectStorage] local delete failed', { storageKey, err });
      ok = false;
    }
  }

  return ok;
}

export async function getPresignedGetUrl(
  storageKey: string,
  expiresInSeconds: number
): Promise<string> {
  if (!isObjectStorageEnabled()) {
    throw new Error('S3 is not configured');
  }

  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: config.aws.bucketName,
      Key: objectKey(storageKey),
    }),
    { expiresIn: expiresInSeconds }
  );
}

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  json: 'application/json',
  bin: 'application/octet-stream',
};

export function mimeTypeFromStorageKey(storageKey: string): string {
  const ext = path.extname(storageKey).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function sumLocalDirBytes(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await sumLocalDirBytes(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }
  } catch {
    // missing prefix = zero usage
  }
  return total;
}

/** Sum object sizes under a tenant-relative prefix (S3 or local uploads fallback). */
export async function sumObjectBytesUnderPrefix(storagePrefix: string): Promise<number> {
  if (isObjectStorageEnabled()) {
    let total = 0;
    let continuationToken: string | undefined;
    const prefix = objectKey(storagePrefix.endsWith('/') ? storagePrefix : `${storagePrefix}/`);
    // ponytail: paginates ListObjectsV2; very large galleries may be slow — cache later if hot
    do {
      const response = await getS3Client().send(
        new ListObjectsV2Command({
          Bucket: config.aws.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of response.Contents ?? []) {
        total += obj.Size ?? 0;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return total;
  }

  return sumLocalDirBytes(path.join(UPLOADS_ROOT, storagePrefix));
}
