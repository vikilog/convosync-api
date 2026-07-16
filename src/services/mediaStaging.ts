import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import {
  getObject,
  getPresignedGetUrl,
  isObjectStorageEnabled,
  putObject,
} from './objectStorage.js';

const STAGING_TTL_MS = 20 * 60 * 1000;

type StagingMeta = {
  mimeType: string;
  fileName?: string;
  storageKey: string;
  expiresAt: number;
};

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

function signStaging(stagingId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${stagingId}:${expiresAt}`)
    .digest('hex');
}

export function verifyStagingSignature(
  stagingId: string,
  expiresAt: number,
  sig: string
): boolean {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = signStaging(stagingId, expiresAt);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export type StagedMedia = {
  stagingId: string;
  publicUrl: string;
  expiresAt: number;
};

export function assertPublicHttpsBaseUrl(): void {
  if (isObjectStorageEnabled()) return;
  if (!config.backendPublicUrl.startsWith('https://')) {
    throw new Error(
      'Instagram media requires BACKEND_PUBLIC_URL to be a public HTTPS URL (e.g. your API domain), or configure AWS S3.'
    );
  }
}

export async function stageMediaForMetaFetch(
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<StagedMedia> {
  assertPublicHttpsBaseUrl();

  const stagingId = crypto.randomUUID();
  const ext = extensionForMime(mimeType, fileName);
  const expiresAt = Date.now() + STAGING_TTL_MS;
  const storageKey = `_staging/${stagingId}.${ext}`;
  const metaStorageKey = `_staging/${stagingId}.meta.json`;

  await putObject(storageKey, buffer, mimeType);
  const meta: StagingMeta = { mimeType, fileName, storageKey, expiresAt };
  await putObject(metaStorageKey, Buffer.from(JSON.stringify(meta)), 'application/json');

  const expiresInSeconds = Math.ceil(STAGING_TTL_MS / 1000);
  const publicUrl = isObjectStorageEnabled()
    ? await getPresignedGetUrl(storageKey, expiresInSeconds)
    : (() => {
        const sig = signStaging(stagingId, expiresAt);
        return `${config.backendPublicUrl}/api/media/meta-fetch/${stagingId}?exp=${expiresAt}&sig=${sig}`;
      })();

  return { stagingId, publicUrl, expiresAt };
}

export async function readStagedMedia(
  stagingId: string,
  expiresAt: number,
  sig: string
): Promise<{ buffer: Buffer; mimeType: string; fileName?: string }> {
  if (!verifyStagingSignature(stagingId, expiresAt, sig)) {
    throw new Error('Invalid or expired media link');
  }

  const metaStorageKey = `_staging/${stagingId}.meta.json`;
  const metaRaw = await getObject(metaStorageKey);
  const meta = JSON.parse(metaRaw.toString('utf8')) as StagingMeta;

  if (Date.now() > meta.expiresAt) {
    throw new Error('Staging media expired');
  }

  const buffer = await getObject(meta.storageKey);
  return { buffer, mimeType: meta.mimeType, fileName: meta.fileName };
}
