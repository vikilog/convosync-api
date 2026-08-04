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

export async function deleteMediaGalleryFile(storageKey?: string | null): Promise<void> {
  if (!storageKey) return;
  await deleteObject(storageKey);
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
