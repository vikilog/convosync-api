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
  mediaTypeFromMime,
  readMediaGalleryFile,
  saveMediaGalleryFile,
} from '../modules/media-gallery/media-storage.js';
import { getPresignedGetUrl, isObjectStorageEnabled } from '../services/objectStorage.js';
import {
  assertMediaGalleryAllowed,
  assertMediaStorageUploadAllowed,
  getWorkspacePlanFeatures,
  PlanGateError,
  storageLimitBytesFromPlan,
} from '../services/planUsageGuards.js';

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
      return reply
        .header('Content-Type', row.mimeType || mimeType)
        .header(
          'Content-Disposition',
          `inline; filename="${row.filename.replace(/"/g, '')}"`
        )
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: 'Media file not found' });
    }
  });

  /** Presigned S3 GET — bucket is private so stored `url` alone breaks in <img>. */
  fastify.get('/:mediaId/signed-url', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const query = request.query as { expiresIn?: string };
    // ponytail: S3 sigv4 practical max ~7d; re-pick or re-sign later if needed
    const expiresIn = Math.min(
      Math.max(Number(query.expiresIn) || 604_800, 60),
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
      if (!isAllowedMime(mimeType)) {
        return reply.code(400).send({ error: 'Unsupported media type' });
      }
      if (!TYPE.safeParse(type).success) {
        type = mediaTypeFromMime(mimeType, filename);
      }
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
      try {
        const { storageKey, url } = await saveMediaGalleryFile(
          workspaceId,
          created.id,
          parsed.fileBuffer,
          mimeType,
          filename
        );
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
        await prisma.mediaAsset.delete({ where: { id: created.id } }).catch(() => undefined);
        if (err instanceof MediaStorageError) {
          return reply.code(503).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }

    const item = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: created.id } });
    return reply.code(201).send(item);
  });

  fastify.patch('/:mediaId', galleryAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const existing = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, workspaceId },
    });
    if (!existing) return reply.code(404).send({ error: 'Media not found' });

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

    await deleteMediaGalleryFile(existing.storageKey);
    await prisma.mediaAsset.delete({ where: { id: mediaId } });
    return { success: true };
  });
}
