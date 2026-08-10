import multipart from '@fastify/multipart';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, scopedUpdateData } from '../middleware/workspaceScope.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import { metaCategoryToSystem, metaStatusToSystem } from '../constants/templateLabels.js';
import {
  buildMetaComponents,
  createMetaMessageTemplate,
  deleteMetaMessageTemplate,
  fetchMetaMessageTemplates,
  metaErrorMessage,
  normalizeMetaLanguageCode,
  parseMetaComponents,
  sanitizeTemplateName,
} from '../services/metaMessageTemplates.js';
import {
  headerFormatForMime,
  isAllowedTemplateHeaderMime,
  readTemplateHeaderMedia,
  saveTemplateHeaderMedia,
  uploadMetaResumableMedia,
} from '../services/templateMedia.js';

const templateBodySchema = z.object({
  name: z.string().min(1),
  category: z.enum(['Utility', 'Marketing', 'Authentication', 'UTILITY', 'MARKETING', 'AUTHENTICATION']),
  language: z.string().min(2).default('en'),
  bodyPattern: z.string().min(1),
  header: z.string().optional().nullable(),
  headerFormat: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional().nullable(),
  headerMediaHandle: z.string().optional().nullable(),
  headerMediaStorageKey: z.string().optional().nullable(),
  headerMediaMimeType: z.string().optional().nullable(),
  headerMediaFileName: z.string().optional().nullable(),
  footer: z.string().optional().nullable(),
  variables: z.array(z.string()).optional(),
  buttonType: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']).optional().nullable(),
  buttonText: z.string().optional().nullable(),
  buttonUrl: z.string().optional().nullable(),
  buttonPhoneNumber: z.string().optional().nullable(),
  buttonUrlSample: z.string().optional().nullable(),
  variableSamples: z.array(z.string()).optional(),
  submitToMeta: z.boolean().optional(),
});

function normalizeCategory(category: string) {
  return metaCategoryToSystem(category);
}

async function resolveHeaderMediaHandle(
  workspaceId: string,
  record: {
    headerFormat: string | null;
    headerMediaHandle: string | null;
    headerMediaStorageKey: string | null;
  }
): Promise<string | null> {
  if (record.headerMediaHandle?.trim()) return record.headerMediaHandle.trim();
  const format = (record.headerFormat || '').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) return null;
  if (!record.headerMediaStorageKey?.startsWith(`${workspaceId}/template-headers/`)) {
    return null;
  }
  const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
  const { buffer, mimeType } = await readTemplateHeaderMedia(record.headerMediaStorageKey);
  return uploadMetaResumableMedia(creds.accessToken, buffer, mimeType);
}

async function buildComponentsForSubmit(
  workspaceId: string,
  record: {
    bodyPattern: string;
    header: string | null;
    headerFormat: string | null;
    headerMediaHandle: string | null;
    headerMediaStorageKey: string | null;
    footer: string | null;
    buttonType: string | null;
    buttonText: string | null;
    buttonUrl: string | null;
    buttonPhoneNumber: string | null;
    variables: string[];
  }
) {
  const headerMediaHandle = await resolveHeaderMediaHandle(workspaceId, record);
  return buildMetaComponents({
    bodyPattern: record.bodyPattern,
    header: record.header,
    headerFormat: record.headerFormat,
    headerMediaHandle,
    footer: record.footer,
    buttonType: record.buttonType,
    buttonText: record.buttonText,
    buttonUrl: record.buttonUrl,
    buttonPhoneNumber: record.buttonPhoneNumber,
    buttonUrlSample: record.buttonUrl?.includes('{{') ? 'sample_link_id' : undefined,
    variableSamples: record.variables,
  });
}

async function syncTemplatesFromMeta(workspaceId: string) {
  const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
  const metaList = await fetchMetaMessageTemplates(creds);

  for (const mt of metaList) {
    const parsed = parseMetaComponents(mt.components);
    const status = metaStatusToSystem(mt.status);
    await prisma.template.upsert({
      where: {
        workspaceId_name: { workspaceId, name: mt.name },
      },
      create: {
        workspaceId,
        name: mt.name,
        category: normalizeCategory(mt.category),
        status,
        language: mt.language || 'en',
        bodyPattern: parsed.bodyPattern || '(empty)',
        header: parsed.header,
        headerFormat: parsed.headerFormat,
        footer: parsed.footer,
        variables: parsed.variables,
        buttons: parsed.buttons,
        buttonType: parsed.buttonType,
        buttonText: parsed.buttonText,
        buttonUrl: parsed.buttonUrl,
        buttonPhoneNumber: parsed.buttonPhoneNumber,
        rejectionReason: mt.rejected_reason ?? null,
        waTemplateId: mt.id ?? null,
      },
      update: {
        category: normalizeCategory(mt.category),
        status,
        language: mt.language || 'en',
        bodyPattern: parsed.bodyPattern || '(empty)',
        header: parsed.header,
        headerFormat: parsed.headerFormat,
        footer: parsed.footer,
        variables: parsed.variables,
        buttons: parsed.buttons,
        buttonType: parsed.buttonType,
        buttonText: parsed.buttonText,
        buttonUrl: parsed.buttonUrl,
        buttonPhoneNumber: parsed.buttonPhoneNumber,
        rejectionReason: mt.rejected_reason ?? null,
        waTemplateId: mt.id ?? null,
      },
    });
  }

  return metaList.length;
}

export default async function templateRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { sync } = request.query as { sync?: string };
    if (sync === '1' || sync === 'true') {
      try {
        await syncTemplatesFromMeta(workspaceId);
      } catch (err) {
        fastify.log.warn({ err }, 'Meta template sync failed');
      }
    }
    return prisma.template.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
  });

  fastify.post('/sync', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      const count = await syncTemplatesFromMeta(workspaceId);
      const templates = await prisma.template.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
      });
      return { synced: count, templates };
    } catch (err) {
      return reply.code(400).send({ error: metaErrorMessage(err) });
    }
  });

  fastify.post('/header-media', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    // persistOnly=1: store for later send (campaigns) without Meta resumable handle
    const persistOnly =
      (request.query as { persistOnly?: string }).persistOnly === '1' ||
      (request.query as { persistOnly?: string }).persistOnly === 'true';
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await part.toBuffer();
    const mimeType = part.mimetype || 'application/octet-stream';
    if (!isAllowedTemplateHeaderMime(mimeType)) {
      return reply.code(400).send({
        error: 'Use JPEG/PNG for image, MP4 for video, or PDF for document headers.',
      });
    }

    const headerFormat = headerFormatForMime(mimeType);
    if (!headerFormat) {
      return reply.code(400).send({ error: 'Unsupported file type for template header.' });
    }

    try {
      let handle = '';
      if (!persistOnly) {
        const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
        handle = await uploadMetaResumableMedia(creds.accessToken, buffer, mimeType);
      }
      const storageKey = await saveTemplateHeaderMedia(
        workspaceId,
        buffer,
        mimeType,
        part.filename
      );
      return {
        headerFormat,
        headerMediaHandle: handle || storageKey,
        headerMediaStorageKey: storageKey,
        headerMediaMimeType: mimeType,
        headerMediaFileName: part.filename || null,
      };
    } catch (err) {
      return reply.code(400).send({ error: metaErrorMessage(err) });
    }
  });

  fastify.get('/header-media/*', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const storageKey = (request.params as { '*': string })['*'];
    if (!storageKey || !storageKey.startsWith(`${workspaceId}/template-headers/`)) {
      return reply.code(404).send({ error: 'Media not found' });
    }
    try {
      const { buffer, mimeType } = await readTemplateHeaderMedia(storageKey);
      return reply.header('Content-Type', mimeType).header('Cache-Control', 'private, max-age=3600').send(buffer);
    } catch {
      return reply.code(404).send({ error: 'Media not found' });
    }
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const template = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = templateBodySchema.parse(request.body);
    const name = sanitizeTemplateName(body.name);
    const submitToMeta = body.submitToMeta !== false;

    const existing = await prisma.template.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
    });
    if (existing) {
      return reply.code(409).send({ error: 'A template with this name already exists for this company' });
    }

    const buttons = body.buttonText?.trim() ? [body.buttonText.trim()] : [];
    let status = 'draft';
    let waTemplateId: string | null = null;
    let rejectionReason: string | null = null;

    const language = normalizeMetaLanguageCode(body.language);

    if (submitToMeta) {
      try {
        const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
        let components;
        try {
          const headerMediaHandle =
            body.headerMediaHandle ||
            (await resolveHeaderMediaHandle(workspaceId, {
              headerFormat: body.headerFormat ?? null,
              headerMediaHandle: body.headerMediaHandle ?? null,
              headerMediaStorageKey: body.headerMediaStorageKey ?? null,
            }));
          components = buildMetaComponents({
            bodyPattern: body.bodyPattern,
            header: body.header,
            headerFormat: body.headerFormat,
            headerMediaHandle,
            footer: body.footer,
            buttonType: body.buttonType,
            buttonText: body.buttonText,
            buttonUrl: body.buttonUrl,
            buttonPhoneNumber: body.buttonPhoneNumber,
            buttonUrlSample: body.buttonUrlSample ?? (body.buttonUrl?.includes('{{') ? 'sample_link_id' : undefined),
            variableSamples: body.variableSamples ?? body.variables,
          });
        } catch (validationErr) {
          return reply.code(400).send({
            error: validationErr instanceof Error ? validationErr.message : 'Invalid template',
          });
        }
        const metaRes = await createMetaMessageTemplate(creds, {
          name,
          category: body.category,
          language,
          components,
        });
        waTemplateId = metaRes.id ?? null;
        status = metaStatusToSystem(metaRes.status || 'PENDING');
      } catch (err) {
        return reply.code(400).send({ error: metaErrorMessage(err) });
      }
    }

    const template = await prisma.template.create({
      data: {
        name,
        category: normalizeCategory(body.category),
        language,
        bodyPattern: body.bodyPattern,
        header: body.header ?? null,
        headerFormat: body.headerFormat ?? null,
        headerMediaHandle: body.headerMediaHandle ?? null,
        headerMediaStorageKey: body.headerMediaStorageKey ?? null,
        headerMediaMimeType: body.headerMediaMimeType ?? null,
        headerMediaFileName: body.headerMediaFileName ?? null,
        footer: body.footer ?? null,
        variables: body.variables ?? [],
        buttons,
        buttonType: body.buttonType ?? null,
        buttonText: body.buttonText ?? null,
        buttonUrl: body.buttonUrl ?? null,
        buttonPhoneNumber: body.buttonPhoneNumber ?? null,
        status,
        waTemplateId,
        rejectionReason,
        workspaceId,
      },
    });
    return reply.code(201).send(template);
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    const body = templateBodySchema.partial().parse(request.body);

    // Approved on Meta: name/body locked; allow local language fix so send matches Meta's code.
    if (existing.status === 'approved') {
      if (body.language == null || !String(body.language).trim()) {
        return reply.code(400).send({
          error:
            'Approved templates can only update language (must match Meta). Create a new template to change content.',
        });
      }
      const template = await prisma.template.update({
        where: { id },
        data: { language: normalizeMetaLanguageCode(body.language) },
      });
      return template;
    }

    // Meta-only fields — not on Template model
    const { submitToMeta: _s, variableSamples: _v, buttonUrlSample: _b, ...rest } = body;
    const data = scopedUpdateData(rest as Record<string, unknown>);

    if (typeof rest.name === 'string') {
      data.name = sanitizeTemplateName(rest.name);
    }
    if (rest.category) data.category = normalizeCategory(rest.category);
    if (rest.language != null) data.language = normalizeMetaLanguageCode(rest.language);
    if (rest.buttonText !== undefined) {
      data.buttons = rest.buttonText?.trim() ? [rest.buttonText.trim()] : [];
    }

    const template = await prisma.template.update({
      where: { id },
      data,
    });
    return template;
  });

  fastify.post('/:id/refresh-status', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    try {
      const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
      const metaList = await fetchMetaMessageTemplates(creds);
      const mt = metaList.find((t) => t.name === existing.name);
      if (!mt) {
        return {
          ...existing,
          metaFound: false,
          message:
            existing.status === 'draft'
              ? 'Not on Meta yet — submit this template first.'
              : 'No matching template found on Meta for this name.',
        };
      }
      const template = await prisma.template.update({
        where: { id },
        data: {
          status: metaStatusToSystem(mt.status),
          category: normalizeCategory(mt.category),
          language: mt.language || existing.language,
          rejectionReason: mt.rejected_reason ?? null,
          waTemplateId: mt.id ?? existing.waTemplateId,
        },
      });
      return { ...template, metaFound: true };
    } catch (err) {
      return reply.code(400).send({ error: metaErrorMessage(err) });
    }
  });

  fastify.post('/:id/submit', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    if (existing.status === 'approved') {
      return reply.code(400).send({ error: 'Template is already approved on Meta' });
    }

    try {
      const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
      let components;
      try {
        components = await buildComponentsForSubmit(workspaceId, existing);
      } catch (validationErr) {
        return reply.code(400).send({
          error: validationErr instanceof Error ? validationErr.message : 'Invalid template',
        });
      }
      const metaRes = await createMetaMessageTemplate(creds, {
        name: existing.name,
        category: existing.category,
        language: normalizeMetaLanguageCode(existing.language),
        components,
      });
      const template = await prisma.template.update({
        where: { id },
        data: {
          status: metaStatusToSystem(metaRes.status || 'PENDING'),
          waTemplateId: metaRes.id ?? existing.waTemplateId,
          rejectionReason: null,
        },
      });
      return template;
    } catch (err) {
      const message = metaErrorMessage(err);
      await prisma.template.update({
        where: { id },
        data: { status: 'rejected', rejectionReason: message },
      });
      return reply.code(400).send({ error: message });
    }
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    if (existing.waTemplateId || existing.status !== 'draft') {
      try {
        const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
        await deleteMetaMessageTemplate(creds, existing.name);
      } catch (err) {
        fastify.log.warn({ err, template: existing.name }, 'Meta template delete failed');
      }
    }

    await prisma.template.delete({ where: { id } });
    return { ok: true };
  });
}
