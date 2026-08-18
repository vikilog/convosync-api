import path from 'node:path';
import {
  deleteObject,
  getObject,
  getPresignedGetUrl,
  isObjectStorageEnabled,
  mimeTypeFromStorageKey,
  publicObjectUrl,
  putObject,
  sumObjectBytesUnderPrefix,
} from '../../services/objectStorage.js';

function extensionForMime(mimeType: string, fileName?: string): string {
  if (fileName?.includes('.')) {
    return path.extname(fileName).slice(1).toLowerCase() || 'bin';
  }
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  return map[mimeType] || mimeType.split('/')[1]?.split('+')[0] || 'bin';
}

export function mediaTypeFromMime(
  mimeType: string,
  fileName?: string
): 'image' | 'pdf' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'document';
}

/**
 * SVG is the one "image/*" MIME that is itself active content — a valid SVG
 * document can carry <script> or onload="" and a browser executes it when
 * the file is opened directly (e.g. GET /:mediaId/file, which serves
 * Content-Disposition: inline). No magic-byte check can tell a "safe" SVG
 * from a malicious one since script tags are ordinary, well-formed SVG
 * syntax — the only sound fix is disallowing the format outright.
 */
export function isDisallowedActiveContentMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().trim();
  return normalized === 'image/svg+xml' || normalized === 'text/html' || normalized === 'application/xhtml+xml';
}

/**
 * Best-effort magic-byte check for the common binary formats this gallery
 * actually expects — catches a file whose bytes don't match its declared
 * Content-Type at all (e.g. an HTML/script payload declared as image/png).
 * Formats without a reliable/simple signature (plain text, the ZIP/OLE-based
 * Office formats) are intentionally not sniffed here — they don't render as
 * active content when served inline, so a mismatched declared type for
 * those is a lower-severity metadata bug, not an XSS vector.
 */
export function sniffMatchesDeclaredMime(buffer: Buffer, mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().trim();
  if (buffer.length < 12) return true; // too short to meaningfully sniff — don't false-reject

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  const isWebp =
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;
  const isMp4 = buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
  const isWebm = buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  const isPdf = buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;

  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return isJpeg;
  if (normalized === 'image/png') return isPng;
  if (normalized === 'image/gif') return isGif;
  if (normalized === 'image/webp') return isWebp;
  if (normalized === 'video/mp4' || normalized === 'video/quicktime') return isMp4;
  if (normalized === 'video/webm') return isWebm;
  if (normalized === 'application/pdf') return isPdf;

  // Unrecognized-but-allowed type (other video/* variants, Office docs,
  // text/plain) — nothing to sniff against, don't false-reject.
  return true;
}

export class MediaStorageError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'MediaStorageError';
  }
}

/**
 * Persist gallery file to S3 (required). Returns storageKey + public S3 URL.
 */
export async function saveMediaGalleryFile(
  workspaceId: string,
  mediaId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<{ storageKey: string; url: string }> {
  if (!isObjectStorageEnabled()) {
    throw new MediaStorageError(
      'S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET_NAME.',
      'S3_NOT_CONFIGURED'
    );
  }

  const ext = extensionForMime(mimeType, fileName);
  const storageKey = `${workspaceId}/media-gallery/${mediaId}.${ext}`;
  await putObject(storageKey, buffer, mimeType);
  return { storageKey, url: publicObjectUrl(storageKey) };
}

export async function readMediaGalleryFile(storageKey: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const buffer = await getObject(storageKey);
  return { buffer, mimeType: mimeTypeFromStorageKey(storageKey) };
}

/** Returns true if the object is confirmed gone — see objectStorage.ts's deleteObject. */
export async function deleteMediaGalleryFile(storageKey?: string | null): Promise<boolean> {
  if (!storageKey) return true;
  return deleteObject(storageKey);
}

/** True when a replace wrote a different S3 key (e.g. .jpg → .png) and the old object must go. */
export function shouldDeleteReplacedMediaKey(
  oldKey: string | null | undefined,
  newKey: string
): boolean {
  return Boolean(oldKey && oldKey !== newKey);
}

export function mediaGalleryStoragePrefix(workspaceId: string): string {
  return `${workspaceId}/media-gallery`;
}

/** Aggregate byte usage for a workspace's media gallery prefix in S3 (or local uploads). */
export async function getMediaGalleryUsedBytes(workspaceId: string): Promise<number> {
  return sumObjectBytesUnderPrefix(mediaGalleryStoragePrefix(workspaceId));
}

/**
 * Meta IG/Messenger Send API needs a fetchable HTTPS URL (no upload-by-id).
 * Prefer a short-lived signed URL so private buckets still work; fall back to stored url.
 */
export async function resolveMetaFetchableMediaUrl(asset: {
  url?: string | null;
  storageKey?: string | null;
}): Promise<string | null> {
  if (asset.storageKey && isObjectStorageEnabled()) {
    try {
      // ponytail: 1h ceiling — Meta fetches promptly; bump if large video uploads stall
      return await getPresignedGetUrl(asset.storageKey, 3600);
    } catch {
      // fall through to stored URL
    }
  }
  if (asset.url?.startsWith('https://')) return asset.url;
  return null;
}
