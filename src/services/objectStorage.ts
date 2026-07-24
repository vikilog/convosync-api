import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

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

  const fullPath = path.join(UPLOADS_ROOT, storageKey);
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

  return fs.readFile(path.join(UPLOADS_ROOT, storageKey));
}

export async function deleteObject(storageKey: string): Promise<void> {
  if (isObjectStorageEnabled()) {
    try {
      await getS3Client().send(
        new DeleteObjectCommand({
          Bucket: config.aws.bucketName,
          Key: objectKey(storageKey),
        })
      );
    } catch {
      // ignore missing objects
    }
  }

  try {
    await fs.unlink(path.join(UPLOADS_ROOT, storageKey));
  } catch {
    // ignore missing files
  }
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
