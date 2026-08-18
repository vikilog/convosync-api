import multipart from '@fastify/multipart';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  MediaStorageError,
  deleteMediaGalleryFile,
  getMediaGalleryUsedBytes,
  isDisallowedActiveContentMime,
  mediaTypeFromMime,
  readMediaGalleryFile,
  saveMediaGalleryFile,
  shouldDeleteReplacedMediaKey,
  sniffMatchesDeclaredMime,
} from '../modules/media-gallery/media-storage.js';
import { getPresignedGetUrl, isObjectStorageEnabled } from '../services/objectStorage.js';
import {
  acquireMediaUploadLock,
  assertMediaGalleryAllowed,
  assertMediaStorageUploadAllowed,
  getWorkspacePlanFeatures,
  MediaUploadBusyError,
  PlanGateError,
  releaseMediaUploadLock,
  storageLimitBytesFromPlan,
} from '../services/planUsageGuards.js';
import { contentDisposition } from '../utils/contentDisposition.js';

const SCOPE = z.enum(['customer', 'partner', 'both']);
const TYPE = z.enum(['image', 'pdf', 'video', 'document']);

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(8000).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  scope: SCOPE.optional(),
  usage: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  type: TYPE.optional(),
  isActive: z.boolean().optional(),
  filename: z.string().min(1).max(255).optional(),
  url: z.string().url().optional(),
});

const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

function isAllowedMime(mimeType: string): boolean {
  if (isDisallowedActiveContentMime(mimeType)) return false;
  if (ALLOWED_MIME_EXACT.has(mimeType)) return true;
  return ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

function parseTags(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* csv */
  }
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

function parseUsage(raw: string): string[] {
  const tags = parseTags(raw);
  return tags.length > 0 ? tags : ['agent'];
}

async function guardMediaGallery(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  try {
    await assertMediaGalleryAllowed(workspaceId);
  } catch (err) {
    if (err instanceof PlanGateError) {
      return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
    }
    throw err;
  }
}

async function parseCreateMultipart(request: FastifyRequest) {
  let title = '';
  let description = '';
  let scope = 'customer';
  let typeHint = '';
  let tagsRaw = '';
  let usageRaw = 'agent';
  let url = '';
  let fileBuffer: Buffer | null = null;
  let mimeType = '';
  let fileName = '';

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      fileBuffer = await part.toBuffer();
      mimeType = part.mimetype || 'application/octet-stream';
      fileName = part.filename || 'file';
    } else {
      const value = String(part.value ?? '').trim();
      if (part.fieldname === 'title') title = value;
      if (part.fieldname === 'description') description = String(part.value ?? '');
      if (part.fieldname === 'scope') scope = value || 'customer';
      if (part.fieldname === 'type') typeHint = value;
      if (part.fieldname === 'tags') tagsRaw = value;
      if (part.fieldname === 'usage') usageRaw = value || 'agent';
      if (part.fieldname === 'url') url = value;
    }
  }

  return {
    title,
    description,
    scope,
    typeHint,
    tags: parseTags(tagsRaw),
    usage: parseUsage(usageRaw),
    url,
    fileBuffer,
    mimeType,
    fileName,
  };
}

/** Top-level Media Gallery — workspace-scoped (tenant = workspaceId). */
export default async function mediaGalleryRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;
  const galleryAuth = { onRequest: auth.onRequest, preHandler: guardMediaGallery };

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  });

  fastify.get('/usage', galleryAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const features = await getWorkspacePlanFeatures(workspaceId);
    const [usedBytes, limitBytes] = await Promise.all([
      getMediaGalleryUsedBytes(workspaceId),
      Promise.resolve(storageLimitBytesFromPlan(features)),
    ]);
    return {
      usedBytes,
      limitBytes,
      storageGb: features.storageGb,
    };
  });

  fastify.get('/', galleryAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const q = request.query as {
      activeOnly?: string;
      scope?: string;
      usage?: string;
      tag?: string;
    };

    const where: {
      workspaceId: string;
      isActive?: boolean;
      scope?: string;
      usage?: { has: string };
      tags?: { has: string };
    } = { workspaceId };

    if (q.activeOnly === '1' || q.activeOnly === 'true') where.isActive = true;
    if (q.scope === 'customer' || q.scope === 'partner' || q.scope === 'both') {
      where.scope = q.scope;
    }
    if (q.usage?.trim()) where.usage = { has: q.usage.trim() };
    if (q.tag?.trim()) where.tags = { has: q.tag.trim() };

    return prisma.mediaAsset.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  });

  fastify.get('/:mediaId/file', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const row = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, workspaceId },
    });
    if (!row?.storageKey) return reply.code(404).send({ error: 'No media file' });
    try {
      const { buffer, mimeType } = await readMediaGalleryFile(row.storageKey);
      // Fastify rejects non-Buffer objects; coerce in case a TypedArray slips through
      const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return reply
        .header('Content-Type', row.mimeType || mimeType)
        .header('Content-Disposition', contentDisposition('inline', row.filename || 'file'))
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'Media file not found' });
    }
  });

  /** Presigned S3 GET — bucket is private so stored `url` alone breaks in <img>. */
  fastify.get('/:mediaId/signed-url', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const query = request.query as { expiresIn?: string };
    // ponytail: S3 sigv4 practical max ~7d; re-pick or re-sign later if needed.
    // Default (when a caller omits expiresIn) is a conservative 1h, not the
    // 7-day ceiling — a leaked URL (forwarded in a message, logged,
    // screen-shared) should only grant unauthenticated read access
    // briefly. Callers with a real need for longer (the email builder
    // refreshing a template's image links) pass it explicitly.
    const expiresIn = Math.min(
      Math.max(Number(query.expiresIn) || 3600, 60),
      604_800
    );

    const row = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, workspaceId },
    });
    if (!row?.storageKey) return reply.code(404).send({ error: 'No media file' });
    if (!isObjectStorageEnabled()) {
      return reply.code(503).send({
        error: 'S3 is not configured; cannot create a shareable image URL.',
        code: 'S3_NOT_CONFIGURED',
      });
    }

    try {
      const url = await getPresignedGetUrl(row.storageKey, expiresIn);
      return { url, expiresIn, mediaId: row.id };
    } catch (err) {
      request.log.error({ err, mediaId }, 'Failed to create media signed URL');
      return reply.code(502).send({ error: 'Failed to create signed URL' });
    }
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'Expected multipart form with file' });
    }

    const parsed = await parseCreateMultipart(request);
    if (!parsed.title.trim()) {
      return reply.code(400).send({ error: 'Title is required' });
    }
    if (!parsed.description.trim()) {
      return reply.code(400).send({ error: 'Description is required (used for matching)' });
    }
    if (!parsed.fileBuffer?.length && !parsed.url) {
      return reply.code(400).send({ error: 'File or url is required' });
    }
    if (parsed.fileBuffer?.length && !isObjectStorageEnabled()) {
      return reply.code(503).send({
        error:
          'S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET_NAME to upload media.',
        code: 'S3_NOT_CONFIGURED',
      });
    }

    // The quota check (assertMediaStorageUploadAllowed) reads a live S3
    // byte-sum with no atomic reservation behind it — two concurrent
    // uploads for the same workspace could otherwise both pass the check
    // before either write lands. Serialize the check-through-upload window
    // per workspace instead.
    const hasFile = Boolean(parsed.fileBuffer?.length);
    if (hasFile) {
      try {
        await acquireMediaUploadLock(workspaceId);
      } catch (err) {
        if (err instanceof MediaUploadBusyError) {
          return reply.code(429).send({ error: err.message });
        }
        throw err;
      }
    }

    try {
      try {
        if (parsed.fileBuffer?.length) {
          await assertMediaStorageUploadAllowed(workspaceId, parsed.fileBuffer.length);
        } else {
          await assertMediaGalleryAllowed(workspaceId);
        }
      } catch (err) {
        if (err instanceof PlanGateError) {
          return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
        }
        throw err;
      }

      const scopeParsed = SCOPE.safeParse(parsed.scope || 'customer');
      if (!scopeParsed.success) {
        return reply.code(400).send({ error: 'Invalid scope' });
      }

      let mimeType = parsed.mimeType || 'application/octet-stream';
      let filename = parsed.fileName || 'file';
      let type = parsed.typeHint;

      if (parsed.fileBuffer?.length) {
        if (!isAllowedMime(mimeType) || !sniffMatchesDeclaredMime(parsed.fileBuffer, mimeType)) {
          return reply.code(400).send({ error: 'Unsupported media type' });
        }
        // Always derive from the actual mimeType when a real file is
        // present — a client-supplied `type` was only reconciled when it
        // failed schema validation, so a schema-valid but wrong hint (e.g.
        // `type: 'document'` on an actual video/mp4 upload) previously
        // passed straight through uncorrected.
        type = mediaTypeFromMime(mimeType, filename);
      } else if (!TYPE.safeParse(type).success) {
        type = 'document';
      }

      const typeParsed = TYPE.parse(type);

      const created = await prisma.mediaAsset.create({
        data: {
          workspaceId,
          type: typeParsed,
          url: parsed.url || 'pending',
          filename,
          title: parsed.title.trim(),
          description: parsed.description.trim(),
          tags: parsed.tags,
          usage: parsed.usage,
          scope: scopeParsed.data,
          mimeType: parsed.fileBuffer?.length ? mimeType : null,
          isActive: true,
        },
      });

      if (parsed.fileBuffer?.length) {
        let uploadedStorageKey: string | undefined;
        try {
          const { storageKey, url } = await saveMediaGalleryFile(
            workspaceId,
            created.id,
            parsed.fileBuffer,
            mimeType,
            filename
          );
          uploadedStorageKey = storageKey;
          await prisma.mediaAsset.update({
            where: { id: created.id },
            data: {
              storageKey,
              url,
              mimeType,
              filename,
            },
          });
        } catch (err) {
          // If the S3 write itself landed but the DB write after it failed,
          // the object would otherwise be orphaned forever — invisible to
          // every consumer, but still counted against the workspace's
          // storage quota (getMediaGalleryUsedBytes sums the raw S3 prefix,
          // not live MediaAsset rows).
          if (uploadedStorageKey) {
            await deleteMediaGalleryFile(uploadedStorageKey).catch(() => undefined);
          }
          await prisma.mediaAsset.delete({ where: { id: created.id } }).catch(() => undefined);
          if (err instanceof MediaStorageError) {
            return reply.code(503).send({ error: err.message, code: err.code });
          }
          throw err;
        }
      }

      const item = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: created.id } });
      return reply.code(201).send(item);
    } finally {
      if (hasFile) await releaseMediaUploadLock(workspaceId);
    }
  });

  fastify.patch('/:mediaId', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const existing = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'Media not found' });

    // Multipart = metadata edit and/or file replace (JSON path stays for Activate toggle).
    if (request.isMultipart()) {
      const parsed = await parseCreateMultipart(request);
      const data: Record<string, unknown> = {};

      // Client always sends these fields on Edit; apply even when tags/usage are empty.
      if (parsed.title.trim()) data.title = parsed.title.trim();
      if (parsed.description.trim()) data.description = parsed.description.trim();
      data.tags = parsed.tags;
      data.usage = parsed.usage.length ? parsed.usage : ['agent'];
      const scopeParsed = SCOPE.safeParse(parsed.scope || 'customer');
      if (scopeParsed.success) data.scope = scopeParsed.data;

      let replacedOldStorageKey: string | null = null;
      let uploadedNewStorageKey: string | undefined;
      const hasFile = Boolean(parsed.fileBuffer?.length);

      if (hasFile) {
        try {
          await acquireMediaUploadLock(workspaceId);
        } catch (err) {
          if (err instanceof MediaUploadBusyError) {
            return reply.code(429).send({ error: err.message });
          }
          throw err;
        }
      }

      try {
        if (parsed.fileBuffer?.length) {
          if (!isObjectStorageEnabled()) {
            return reply.code(503).send({
              error:
                'S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET_NAME to upload media.',
              code: 'S3_NOT_CONFIGURED',
            });
          }
          const mimeType = parsed.mimeType || 'application/octet-stream';
          if (!isAllowedMime(mimeType) || !sniffMatchesDeclaredMime(parsed.fileBuffer, mimeType)) {
            return reply.code(400).send({ error: 'Unsupported media type' });
          }
          try {
            await assertMediaStorageUploadAllowed(workspaceId, parsed.fileBuffer.length);
          } catch (err) {
            if (err instanceof PlanGateError) {
              return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
            }
            throw err;
          }
          const filename = parsed.fileName || existing.filename || 'file';
          // Always derive from the actual mimeType — see the matching note
          // in POST /.
          const type = mediaTypeFromMime(mimeType, filename);
          try {
            const { storageKey, url } = await saveMediaGalleryFile(
              workspaceId,
              mediaId,
              parsed.fileBuffer,
              mimeType,
              filename
            );
            uploadedNewStorageKey = storageKey;
            // Deleting the old object is deferred until after the DB commit
            // below actually lands — doing it here (before the row points at
            // the new key) meant a failed update left the row referencing an
            // already-deleted file, with the freshly-uploaded object orphaned
            // and nothing pointing at either one.
            if (shouldDeleteReplacedMediaKey(existing.storageKey, storageKey)) {
              replacedOldStorageKey = existing.storageKey ?? null;
            }
            data.storageKey = storageKey;
            data.url = url;
            data.mimeType = mimeType;
            data.filename = filename;
            data.type = TYPE.parse(type);
          } catch (err) {
            if (err instanceof MediaStorageError) {
              return reply.code(503).send({ error: err.message, code: err.code });
            }
            throw err;
          }
        }

        if (Object.keys(data).length === 0) {
          return reply.code(400).send({ error: 'No fields to update' });
        }

        let updated;
        try {
          updated = await prisma.mediaAsset.update({
            where: { id: mediaId },
            data,
          });
        } catch (err) {
          // Roll back the just-uploaded replacement object instead of
          // deleting the old one — leaves the row and its existing file
          // exactly as they were before this request.
          if (uploadedNewStorageKey) {
            await deleteMediaGalleryFile(uploadedNewStorageKey).catch(() => undefined);
          }
          throw err;
        }
        if (replacedOldStorageKey) {
          await deleteMediaGalleryFile(replacedOldStorageKey).catch(() => undefined);
        }
        return updated;
      } finally {
        if (hasFile) await releaseMediaUploadLock(workspaceId);
      }
    }

    const body = updateSchema.parse(request.body ?? {});
    return prisma.mediaAsset.update({
      where: { id: mediaId },
      data: body,
    });
  });

  /** Hard-delete: remove DB row + S3 object */
  fastify.delete('/:mediaId', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const existing = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'Media not found' });

    // A not-yet-completed campaign can override its template's header media
    // with a specific gallery asset id (audienceFilter.headerMediaAssetId).
    // Unlike the AI-agent path (which re-queries active media dynamically —
    // deleting an asset just removes it from that candidate pool) and
    // Instagram journey blocks (which already resolve a missing/deactivated
    // asset to null and degrade gracefully), a campaign with a dangling
    // headerMediaAssetId throws mid-send and gets marked failed — see
    // campaignBroadcast.service.ts's mediaOverride.headerMediaAssetId
    // handling. Block deletion instead of letting that surprise the user
    // days later when the scheduled send fires.
    const referencingCampaign = await prisma.campaign.findFirst({
      where: {
        workspaceId,
        status: { not: 'completed' },
        audienceFilter: { path: ['headerMediaAssetId'], equals: mediaId },
      },
      select: { id: true, name: true },
    });
    if (referencingCampaign) {
      return reply.code(409).send({
        error: `This media is used as the header image for campaign "${referencingCampaign.name}" — remove it from that campaign first.`,
      });
    }

    // Only drop the DB row once the storage object is actually confirmed
    // gone — otherwise a transient S3 failure (throttle, permissions,
    // network) would leave the file sitting in the bucket forever with no
    // record left pointing at it, while the API reports success.
    const storageDeleted = await deleteMediaGalleryFile(existing.storageKey);
    if (!storageDeleted) {
      return reply.code(502).send({
        error: 'Could not delete the stored file — it was not removed locally, try again.',
      });
    }
    await prisma.mediaAsset.delete({ where: { id: mediaId } });
    return { success: true };
  });
}
