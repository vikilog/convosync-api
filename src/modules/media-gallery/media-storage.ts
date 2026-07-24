import path from 'node:path';
import {
  deleteObject,
  getObject,
  isObjectStorageEnabled,
  mimeTypeFromStorageKey,
  publicObjectUrl,
  putObject,
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
