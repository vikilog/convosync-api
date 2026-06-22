import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const STAGING_ROOT = path.join(process.cwd(), 'uploads', '_staging');
const STAGING_TTL_MS = 20 * 60 * 1000;

type StagingMeta = {
  mimeType: string;
  fileName?: string;
  filePath: string;
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
  if (!config.backendPublicUrl.startsWith('https://')) {
    throw new Error(
      'Instagram media requires BACKEND_PUBLIC_URL to be a public HTTPS URL (e.g. your API domain).'
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

  await fs.mkdir(STAGING_ROOT, { recursive: true });

  const filePath = path.join(STAGING_ROOT, `${stagingId}.${ext}`);
  const metaPath = path.join(STAGING_ROOT, `${stagingId}.meta.json`);

  await fs.writeFile(filePath, buffer);
  const meta: StagingMeta = { mimeType, fileName, filePath, expiresAt };
  await fs.writeFile(metaPath, JSON.stringify(meta));

  const sig = signStaging(stagingId, expiresAt);
  const publicUrl = `${config.backendPublicUrl}/api/media/meta-fetch/${stagingId}?exp=${expiresAt}&sig=${sig}`;

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

  const metaPath = path.join(STAGING_ROOT, `${stagingId}.meta.json`);
  const raw = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw) as StagingMeta;

  if (Date.now() > meta.expiresAt) {
    throw new Error('Staging media expired');
  }

  const buffer = await fs.readFile(meta.filePath);
  return { buffer, mimeType: meta.mimeType, fileName: meta.fileName };
}
