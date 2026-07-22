import multipart from '@fastify/multipart';
import { Prisma } from '@prisma/client';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, scopedUpdateData } from '../middleware/workspaceScope.js';
import {
  deleteCannedMediaFile,
  readCannedMediaFile,
  saveCannedMediaFile,
} from '../services/cannedMedia.js';

const createSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().max(4000),
  shortcut: z.string().max(32).nullable().optional(),
});

const updateSchema = createSchema.partial();

const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
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

function validateCannedPayload(body: { title: string; content: string }, hasMedia: boolean) {
  if (!body.content.trim() && !hasMedia) {
    throw new Error('Content or media is required');
  }
}

function duplicateTitleResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(409).send({
    error: 'A canned response with this title already exists. Choose a different title.',
  });
}

function isDuplicateTitleError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray(err.meta?.target) &&
    (err.meta.target as string[]).includes('title')
  );
}

async function parseMultipartBody(request: FastifyRequest) {
  let title = '';
  let content = '';
  let shortcut: string | null = null;
  let removeMedia = false;
  let fileBuffer: Buffer | null = null;
  let mimeType = '';
  let fileName = '';

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      fileBuffer = await part.toBuffer();
      mimeType = part.mimetype || 'application/octet-stream';
      fileName = part.filename || 'file';
    } else if (part.type === 'field') {
      const value = String(part.value ?? '').trim();
      if (part.fieldname === 'title') title = value;
      if (part.fieldname === 'content') content = String(part.value ?? '');
      if (part.fieldname === 'shortcut') shortcut = value || null;
      if (part.fieldname === 'removeMedia') removeMedia = value === 'true' || value === '1';
    }
  }

  return { title, content, shortcut, removeMedia, fileBuffer, mimeType, fileName };
}

export default async function cannedResponseRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return prisma.cannedResponse.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const row = await prisma.cannedResponse.findFirst({ where: { id, workspaceId } });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return row;
  });

  fastify.get('/:id/media', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const row = await prisma.cannedResponse.findFirst({ where: { id, workspaceId } });
    if (!row?.mediaStorageKey) return reply.code(404).send({ error: 'No media' });

    try {
      const { buffer, mimeType } = await readCannedMediaFile(row.mediaStorageKey);
      return reply
        .header('Content-Type', row.mediaMimeType || mimeType)
        .header(
          'Content-Disposition',
          row.mediaFileName
            ? `inline; filename="${row.mediaFileName.replace(/"/g, '')}"`
            : 'inline'
        )
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: 'Media file not found' });
    }
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    if (request.isMultipart()) {
      const parsed = await parseMultipartBody(request);
      if (!parsed.title.trim()) {
        return reply.code(400).send({ error: 'Title is required' });
      }
      const hasNewMedia = Boolean(parsed.fileBuffer?.length);
      try {
        validateCannedPayload(
          { title: parsed.title, content: parsed.content },
          hasNewMedia
        );
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid payload' });
      }
      if (hasNewMedia && !isAllowedMime(parsed.mimeType)) {
        return reply.code(400).send({ error: 'Unsupported media type' });
      }

      let row;
      try {
        row = await prisma.cannedResponse.create({
          data: {
            workspaceId,
            title: parsed.title.trim(),
            content: parsed.content,
            shortcut: parsed.shortcut,
          },
        });
      } catch (err) {
        if (isDuplicateTitleError(err)) return duplicateTitleResponse(reply);
        throw err;
      }

      if (hasNewMedia && parsed.fileBuffer) {
        const storageKey = await saveCannedMediaFile(
          workspaceId,
          row.id,
          parsed.fileBuffer,
          parsed.mimeType,
          parsed.fileName
        );
        const updated = await prisma.cannedResponse.update({
          where: { id: row.id },
          data: {
            mediaStorageKey: storageKey,
            mediaMimeType: parsed.mimeType,
            mediaFileName: parsed.fileName,
          },
        });
        return reply.code(201).send(updated);
      }

      return reply.code(201).send(row);
    }

    const body = createSchema.parse(request.body ?? {});
    validateCannedPayload(body, false);
    try {
      const row = await prisma.cannedResponse.create({
        data: {
          workspaceId,
          title: body.title.trim(),
          content: body.content,
          shortcut: body.shortcut?.trim() || null,
        },
      });
      return reply.code(201).send(row);
    } catch (err) {
      if (isDuplicateTitleError(err)) return duplicateTitleResponse(reply);
      throw err;
    }
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.cannedResponse.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (request.isMultipart()) {
      const parsed = await parseMultipartBody(request);
      const nextTitle = parsed.title.trim() || existing.title;
      const nextContent = parsed.content !== '' ? parsed.content : existing.content;
      const nextShortcut =
        parsed.shortcut !== null && parsed.shortcut !== undefined
          ? parsed.shortcut
          : existing.shortcut;

      const hasNewMedia = Boolean(parsed.fileBuffer?.length);
      const willHaveMedia = hasNewMedia
        ? true
        : parsed.removeMedia
          ? false
          : Boolean(existing.mediaStorageKey);

      try {
        validateCannedPayload({ title: nextTitle, content: nextContent }, willHaveMedia);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid payload' });
      }

      if (hasNewMedia && !isAllowedMime(parsed.mimeType)) {
        return reply.code(400).send({ error: 'Unsupported media type' });
      }

      let mediaStorageKey = existing.mediaStorageKey;
      let mediaMimeType = existing.mediaMimeType;
      let mediaFileName = existing.mediaFileName;

      if (parsed.removeMedia && !hasNewMedia) {
        await deleteCannedMediaFile(existing.mediaStorageKey);
        mediaStorageKey = null;
        mediaMimeType = null;
        mediaFileName = null;
      }

      if (hasNewMedia && parsed.fileBuffer) {
        await deleteCannedMediaFile(existing.mediaStorageKey);
        mediaStorageKey = await saveCannedMediaFile(
          workspaceId,
          id,
          parsed.fileBuffer,
          parsed.mimeType,
          parsed.fileName
        );
        mediaMimeType = parsed.mimeType;
        mediaFileName = parsed.fileName;
      }

      try {
        return await prisma.cannedResponse.update({
          where: { id },
          data: scopedUpdateData({
            title: nextTitle,
            content: nextContent,
            shortcut: nextShortcut,
            mediaStorageKey,
            mediaMimeType,
            mediaFileName,
          }),
        });
      } catch (err) {
        if (isDuplicateTitleError(err)) return duplicateTitleResponse(reply);
        throw err;
      }
    }

    const body = updateSchema.parse(request.body ?? {});
    const nextContent = body.content !== undefined ? body.content : existing.content;
    const willHaveMedia = Boolean(existing.mediaStorageKey);
    try {
      validateCannedPayload(
        { title: body.title ?? existing.title, content: nextContent },
        willHaveMedia
      );
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid payload' });
    }

    const data = scopedUpdateData({
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.shortcut !== undefined ? { shortcut: body.shortcut?.trim() || null } : {}),
    });

    try {
      return await prisma.cannedResponse.update({ where: { id }, data });
    } catch (err) {
      if (isDuplicateTitleError(err)) return duplicateTitleResponse(reply);
      throw err;
    }
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.cannedResponse.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    await deleteCannedMediaFile(existing.mediaStorageKey);
    await prisma.cannedResponse.delete({ where: { id } });
    return { success: true };
  });
}
