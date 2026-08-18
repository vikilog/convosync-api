import axios from 'axios';
import { config } from '../config.js';
import {
  getObject,
  mimeTypeFromStorageKey,
  putObject,
} from './objectStorage.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || 'bin';
}

export function headerFormatForMime(mimeType: string): 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null {
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType === 'application/pdf') return 'DOCUMENT';
  return null;
}

export function isAllowedTemplateHeaderMime(mimeType: string): boolean {
  return headerFormatForMime(mimeType) !== null;
}

/**
 * The client's declared Content-Type is trusted nowhere near enough on its
 * own — a file with a spoofed mimetype (e.g. an HTML/script payload
 * declared as image/png) would otherwise be accepted, stored, and later
 * served back to whoever opens the header-media URL. Sniff the actual file
 * signature and require it to match one of the formats we allow at all;
 * this doesn't have to match the claimed mimeType exactly (browsers are
 * inconsistent about e.g. video/mp4 vs video/quicktime for MP4-family
 * containers), it just has to be a real file of an allowed kind.
 */
export function sniffAllowedHeaderMediaType(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true;
  }
  // PDF: "%PDF"
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return true;
  }
  // MP4/ISO-BMFF family: bytes 4-7 spell "ftyp"
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return true;
  }
  return false;
}

export async function saveTemplateHeaderMedia(
  workspaceId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const ext = extensionForMime(mimeType);
  const id = `th_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const storageKey = `${workspaceId}/template-headers/${id}.${ext}`;
  await putObject(storageKey, buffer, mimeType);
  return storageKey;
}

export async function readTemplateHeaderMedia(storageKey: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const buffer = await getObject(storageKey);
  const ext = storageKey.split('.').pop()?.toLowerCase() || '';
  return { buffer, mimeType: MIME_BY_EXT[ext] || mimeTypeFromStorageKey(storageKey) };
}

export async function uploadMetaResumableMedia(
  accessToken: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const appId = config.meta.appId;
  if (!appId) throw new Error('META_APP_ID is not configured');

  const sessionRes = await axios.post(
    `${GRAPH}/${appId}/uploads`,
    {
      file_length: buffer.length,
      file_type: mimeType,
    },
    { params: { access_token: accessToken } }
  );

  const sessionId = sessionRes.data?.id as string | undefined;
  if (!sessionId) throw new Error('Failed to start Meta media upload session');

  const uploadRes = await axios.post(`${GRAPH}/${sessionId}`, buffer, {
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
      'Content-Type': mimeType,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const handle = uploadRes.data?.h as string | undefined;
  if (!handle) throw new Error('Meta media upload did not return a file handle');
  return handle;
}
