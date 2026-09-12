import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import { UrlFetchError, fetchUrlKnowledge } from '../../services/url-fetch.service.js';
import {
  indexKnowledgeItemInBackground,
  knowledgeIndexService,
} from '../ai-agent/knowledge/knowledge-index.service.js';
import {
  DocumentExtractError,
  extractTextFromDocument,
  isSupportedDocumentFile,
} from '../ai-agent/knowledge/document-text-extract.js';
import { invalidateWorkspaceCache } from '../ai-agent/hybrid/redis-cache.js';
import type {
  KnowledgeCreateBody,
  KnowledgeFetchUrlBody,
  KnowledgeUpdateBody,
} from '../../routes/agents.schemas.js';
import { getAgentOr404 } from './agents.helpers.js';

export async function listKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  return prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId: id },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, kId } = request.params as { id: string; kId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const item = await prisma.aiAgentKnowledgeItem.findFirst({
    where: { id: kId, agentId: id },
  });
  if (!item) return reply.code(404).send({ error: 'Knowledge item not found' });
  return item;
}

export async function fetchKnowledgeUrl(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });

  const body = request.body as KnowledgeFetchUrlBody;

  try {
    const result = await fetchUrlKnowledge({
      agentId: id,
      workspaceId,
      url: body.url,
      refreshInterval: body.refreshInterval,
    });
    void invalidateWorkspaceCache(request.server, workspaceId);
    return result;
  } catch (err) {
    if (err instanceof UrlFetchError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    throw err;
  }
}

export async function createKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const body = request.body as KnowledgeCreateBody;
  const item = await prisma.aiAgentKnowledgeItem.create({
    data: {
      agentId: id,
      type: body.type,
      title: body.title,
      content: body.content,
      url: body.url || null,
      fileUrl: body.fileUrl,
      metadata: body.metadata as object | undefined,
      status: 'ready',
    },
  });
  void indexKnowledgeItemInBackground(workspaceId, item);
  void invalidateWorkspaceCache(request.server, workspaceId);
  return reply.code(201).send(item);
}

/** Document upload — parses PDF/DOCX/TXT/MD into real text before indexing (one file per call). */
export async function uploadKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });

  if (!request.isMultipart()) {
    return reply.code(400).send({ error: 'Expected multipart form with a file' });
  }

  let fileBuffer: Buffer | null = null;
  let mimeType = '';
  let fileName = '';
  let title = '';

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        mimeType = part.mimetype || 'application/octet-stream';
        fileName = part.filename || 'document';
      } else if (part.fieldname === 'title') {
        title = String(part.value ?? '').trim();
      }
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: 'File is larger than the 16 MB limit.' });
    }
    throw err;
  }

  if (!fileBuffer?.length) {
    return reply.code(400).send({ error: 'A file is required' });
  }
  if (!isSupportedDocumentFile(fileName, mimeType)) {
    return reply
      .code(400)
      .send({ error: 'Unsupported file type. Upload PDF, DOCX, TXT, or MD.', code: 'UNSUPPORTED_FORMAT' });
  }

  try {
    const { text, wordCount } = await extractTextFromDocument(fileBuffer, fileName, mimeType);
    const item = await prisma.aiAgentKnowledgeItem.create({
      data: {
        agentId: id,
        type: 'document',
        title: title || fileName,
        content: text,
        metadata: { fileName, wordCount },
        status: 'ready',
      },
    });
    void indexKnowledgeItemInBackground(workspaceId, item);
    void invalidateWorkspaceCache(request.server, workspaceId);
    return reply.code(201).send(item);
  } catch (err) {
    if (err instanceof DocumentExtractError) {
      const statusCode = err.code === 'UNSUPPORTED_FORMAT' ? 400 : 422;
      return reply.code(statusCode).send({ error: err.message, code: err.code });
    }
    throw err;
  }
}

export async function updateKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, kId } = request.params as { id: string; kId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const existing = await prisma.aiAgentKnowledgeItem.findFirst({
    where: { id: kId, agentId: id },
  });
  if (!existing) return reply.code(404).send({ error: 'Knowledge item not found' });

  const body = request.body as KnowledgeUpdateBody;
  const data: {
    title?: string;
    content?: string | null;
    url?: string | null;
    fileUrl?: string | null;
    metadata?: object;
    status?: string;
  } = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.content !== undefined) data.content = body.content;
  if (body.url !== undefined) data.url = body.url || null;
  if (body.fileUrl !== undefined) data.fileUrl = body.fileUrl;
  if (body.metadata !== undefined) data.metadata = body.metadata as object;
  if (body.status !== undefined) data.status = body.status;

  const contentChanged =
    (body.content !== undefined && body.content !== existing.content) ||
    (body.title !== undefined && body.title !== existing.title) ||
    (body.url !== undefined && (body.url || null) !== existing.url);

  const item = await prisma.aiAgentKnowledgeItem.update({
    where: { id: kId },
    data,
  });

  if (contentChanged) {
    await knowledgeIndexService.deleteItemVectors(workspaceId, kId);
    void indexKnowledgeItemInBackground(workspaceId, item);
  }
  void invalidateWorkspaceCache(request.server, workspaceId);
  return item;
}

export async function deleteKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, kId } = request.params as { id: string; kId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const existing = await prisma.aiAgentKnowledgeItem.findFirst({
    where: { id: kId, agentId: id },
  });
  if (!existing) return reply.code(404).send({ error: 'Knowledge item not found' });
  await knowledgeIndexService.deleteItemVectors(workspaceId, kId);
  await prisma.aiAgentKnowledgeItem.delete({ where: { id: kId } });
  void invalidateWorkspaceCache(request.server, workspaceId);
  return { success: true };
}

export async function reindexKnowledge(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });

  const items = await prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId: id, status: 'ready' },
    orderBy: { createdAt: 'asc' },
  });

  void invalidateWorkspaceCache(request.server, workspaceId);
  void (async () => {
    for (const item of items) {
      await indexKnowledgeItemInBackground(workspaceId, item);
    }
  })();

  return { queued: items.length };
}
