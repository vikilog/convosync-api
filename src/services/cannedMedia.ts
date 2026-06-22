import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

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

async function ensureCannedDir(workspaceId: string): Promise<string> {
  const dir = path.join(UPLOADS_ROOT, workspaceId, 'canned');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveCannedMediaFile(
  workspaceId: string,
  cannedId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  await ensureCannedDir(workspaceId);
  const ext = extensionForMime(mimeType, fileName);
  const storageKey = `${workspaceId}/canned/${cannedId}.${ext}`;
  const fullPath = path.join(UPLOADS_ROOT, storageKey);
  await fs.writeFile(fullPath, buffer);
  return storageKey;
}

export async function readCannedMediaFile(storageKey: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const fullPath = path.join(UPLOADS_ROOT, storageKey);
  const buffer = await fs.readFile(fullPath);
  const ext = path.extname(storageKey).slice(1).toLowerCase();
  const mimeByExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
  };
  return { buffer, mimeType: mimeByExt[ext] || 'application/octet-stream' };
}

export async function deleteCannedMediaFile(storageKey?: string | null): Promise<void> {
  if (!storageKey) return;
  const fullPath = path.join(UPLOADS_ROOT, storageKey);
  try {
    await fs.unlink(fullPath);
  } catch {
    // ignore missing files
  }
}
