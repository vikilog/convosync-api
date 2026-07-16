import path from 'node:path';
import {
  deleteObject,
  getObject,
  mimeTypeFromStorageKey,
  putObject,
} from './objectStorage.js';

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
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || mimeType.split('/')[1]?.split('+')[0] || 'bin';
}

export async function saveCannedMediaFile(
  workspaceId: string,
  cannedId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const ext = extensionForMime(mimeType, fileName);
  const storageKey = `${workspaceId}/canned/${cannedId}.${ext}`;
  await putObject(storageKey, buffer, mimeType);
  return storageKey;
}

export async function readCannedMediaFile(storageKey: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const buffer = await getObject(storageKey);
  return { buffer, mimeType: mimeTypeFromStorageKey(storageKey) };
}

export async function deleteCannedMediaFile(storageKey?: string | null): Promise<void> {
  if (!storageKey) return;
  await deleteObject(storageKey);
}
