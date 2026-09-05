import multipart from '@fastify/multipart';
import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
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
  extractVariableIndexes,
  fetchMetaMessageTemplates,
  fetchMetaTemplateAnalytics,
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
  sniffAllowedHeaderMediaType,
  uploadMetaResumableMedia,
} from '../services/templateMedia.js';
import { isHeaderMediaStorageKeyOwnedByWorkspace } from '../services/campaignHeaderMedia.js';

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
  buttonType: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'FLOW']).optional().nullable(),
  buttonText: z.string().optional().nullable(),
  buttonUrl: z.string().optional().nullable(),
  buttonPhoneNumber: z.string().optional().nullable(),
  buttonUrlSample: z.string().optional().nullable(),
  buttonFlowId: z.string().optional().nullable(),
  variableSamples: z.array(z.string()).optional(),
  submitToMeta: z.boolean().optional(),
});

function normalizeCategory(category: string) {
  return metaCategoryToSystem(category);
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * The stored Template.variables length drives buildCampaignBodyParams at
 * campaign-send time (one param built per entry) — if it doesn't match the
 * actual {{n}} placeholder count in bodyPattern, every campaign send using
 * this template builds the wrong number of parameters and gets rejected by
 * Meta at send time, on an otherwise-approved template. buildVariableSamples
 * masks this at submit time by silently padding samples to the body's real
 * count, so this mismatch was previously invisible until send.
 */
function assertVariablesMatchBody(bodyPattern: string, variables: string[]): void {
  const expected = extractVariableIndexes(bodyPattern).length;
  if (variables.length !== expected) {
    throw new Error(
      expected === 0
        ? `bodyPattern has no {{n}} placeholders, but ${variables.length} variable(s) were provided.`
        : `bodyPattern has ${expected} placeholder(s) ({{1}}..{{${expected}}}), but ${variables.length} variable(s) were provided.`
    );
  }
}

// Meta's documented WhatsApp template component limits — checking these
// locally means a template that's too long fails with an immediate, clear
// message instead of only surfacing as an opaque Meta API error at submit.
const META_CONTENT_LIMITS = {
  bodyPattern: 1024,
  header: 60,
  footer: 60,
  buttonText: 25,
} as const;

function assertMetaContentLimits(fields: {
  bodyPattern?: string | null;
  header?: string | null;
  footer?: string | null;
  buttonText?: string | null;
}): void {
  const checks: Array<[keyof typeof META_CONTENT_LIMITS, string | null | undefined]> = [
    ['bodyPattern', fields.bodyPattern],
    ['header', fields.header],
    ['footer', fields.footer],
    ['buttonText', fields.buttonText],
  ];
  for (const [field, value] of checks) {
    if (value && value.length > META_CONTENT_LIMITS[field]) {
      throw new Error(
        `${field} is ${value.length} characters — Meta allows at most ${META_CONTENT_LIMITS[field]}.`
      );
    }
  }
}

/**
 * headerMediaStorageKey is a free-form string field on the request body —
 * unlike headerMediaAssetId (a real workspace-scoped DB row), nothing
 * inherently ties it to the caller's workspace. Without this check a client
 * could set it to another workspace's stored file (or, pre-existing
 * objectStorage.ts hardening aside, attempt a path-traversal string) and
 * have that file read and uploaded to Meta on send — see
 * resolveTemplateHeaderMediaBuffer's matching read-time check.
 */
function assertHeaderMediaStorageKeyOwnership(
  workspaceId: string,
  headerMediaStorageKey: string | null | undefined
): void {
  if (!headerMediaStorageKey) return;
  if (!isHeaderMediaStorageKeyOwnedByWorkspace(headerMediaStorageKey, workspaceId)) {
    throw new Error('Header media does not belong to this workspace');
  }
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

/** Resolves a ConvoSync WhatsAppFlow.id into what Meta's FLOW button component needs. */
async function resolveButtonFlowRefs(
  workspaceId: string,
  buttonType: string | null,
  buttonFlowId: string | null
): Promise<{ metaFlowId: string | null; firstScreenId: string | null }> {
  if (buttonType !== 'FLOW' || !buttonFlowId) return { metaFlowId: null, firstScreenId: null };
  const flow = await prisma.whatsAppFlow.findFirst({ where: { id: buttonFlowId, workspaceId } });
  if (!flow || flow.status !== 'published' || !flow.metaFlowId) {
    throw new Error('Selected flow must be published before it can be used on a template button.');
  }
  const screens = (flow.flowJson as { screens?: Array<{ id?: string }> })?.screens ?? [];
  const firstScreenId = screens[0]?.id ?? null;
  if (!firstScreenId) throw new Error('Selected flow has no screens.');
  return { metaFlowId: flow.metaFlowId, firstScreenId };
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
    buttonFlowId: string | null;
    variables: string[];
  }
) {
  const headerMediaHandle = await resolveHeaderMediaHandle(workspaceId, record);
  const flowRefs = await resolveButtonFlowRefs(workspaceId, record.buttonType, record.buttonFlowId);

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
    buttonFlowMetaId: flowRefs.metaFlowId,
    buttonFlowFirstScreenId: flowRefs.firstScreenId,
    variableSamples: record.variables,
  });
}

async function syncTemplatesFromMeta(workspaceId: string) {
  const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
  const metaList = await fetchMetaMessageTemplates(creds);

  for (const mt of metaList) {
    const parsed = parseMetaComponents(mt.components);
    const status = metaStatusToSystem(mt.status);
    const buttonFlowId = parsed.buttonFlowMetaId
      ? (
          await prisma.whatsAppFlow.findFirst({
            where: { metaFlowId: parsed.buttonFlowMetaId, workspaceId },
            select: { id: true },
          })
        )?.id ?? null
      : null;
    await prisma.template.upsert({
      where: {
        workspaceId_name_language: { workspaceId, name: mt.name, language: mt.language || 'en' },
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
        buttonFlowId,
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
        buttonFlowId,
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
    if (!isAllowedTemplateHeaderMime(mimeType) || !sniffAllowedHeaderMediaType(buffer)) {
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
    // The prefix check alone doesn't reject `..` segments — a key like
    // `${workspaceId}/template-headers/../../other-workspace/x.jpg` still
    // starts with the required prefix. objectStorage.ts's local-disk path
    // resolution now rejects that too (defense in depth), but check it
    // explicitly here as well so a malformed key 404s immediately instead
    // of relying solely on that deeper guard.
    if (
      !storageKey ||
      !storageKey.startsWith(`${workspaceId}/template-headers/`) ||
      storageKey.split('/').includes('..')
    ) {
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

    try {
      assertHeaderMediaStorageKeyOwnership(workspaceId, body.headerMediaStorageKey);
      assertVariablesMatchBody(body.bodyPattern, body.variables ?? []);
      assertMetaContentLimits({
        bodyPattern: body.bodyPattern,
        header: body.headerFormat === 'TEXT' ? body.header : null,
        footer: body.footer,
        buttonText: body.buttonText,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid template' });
    }

    const language = normalizeMetaLanguageCode(body.language);

    const existing = await prisma.template.findUnique({
      where: { workspaceId_name_language: { workspaceId, name, language } },
    });
    if (existing) {
      return reply.code(409).send({
        error: 'A template with this name and language already exists for this company',
      });
    }

    const buttons = body.buttonText?.trim() ? [body.buttonText.trim()] : [];
    let status = 'draft';
    let waTemplateId: string | null = null;
    let rejectionReason: string | null = null;

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
          const flowRefs = await resolveButtonFlowRefs(
            workspaceId,
            body.buttonType ?? null,
            body.buttonFlowId ?? null
          );
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
            buttonFlowMetaId: flowRefs.metaFlowId,
            buttonFlowFirstScreenId: flowRefs.firstScreenId,
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

    let template;
    try {
      template = await prisma.template.create({
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
          buttonFlowId: body.buttonFlowId ?? null,
          status,
          waTemplateId,
          rejectionReason,
          workspaceId,
        },
      });
    } catch (err) {
      // The findUnique check above is a plain read — two concurrent
      // creates for the same name can both pass it. If Meta was already
      // submitted to above, the loser's submission stands at Meta with no
      // local row until a manual /sync rediscovers it; this at least turns
      // the crash into a clean, actionable error instead of a raw 500.
      if (isPrismaUniqueViolation(err)) {
        return reply.code(409).send({
          error:
            'A template with this name and language already exists for this company — refresh, or run Sync if you just submitted it.',
        });
      }
      throw err;
    }
    return reply.code(201).send(template);
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    const body = templateBodySchema.partial().parse(request.body);

    try {
      assertHeaderMediaStorageKeyOwnership(workspaceId, body.headerMediaStorageKey);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid header media' });
    }

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

    try {
      assertVariablesMatchBody(
        rest.bodyPattern ?? existing.bodyPattern,
        rest.variables ?? (existing.variables as string[])
      );
      const effectiveHeaderFormat = rest.headerFormat ?? existing.headerFormat;
      assertMetaContentLimits({
        bodyPattern: rest.bodyPattern ?? existing.bodyPattern,
        header: effectiveHeaderFormat === 'TEXT' ? (rest.header ?? existing.header) : null,
        footer: rest.footer ?? existing.footer,
        buttonText: rest.buttonText ?? existing.buttonText,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid template' });
    }

    const data = scopedUpdateData(rest as Record<string, unknown>);

    if (typeof rest.name === 'string') {
      data.name = sanitizeTemplateName(rest.name);
    }
    if (rest.category) data.category = normalizeCategory(rest.category);
    if (rest.language != null) data.language = normalizeMetaLanguageCode(rest.language);
    if (rest.buttonText !== undefined) {
      data.buttons = rest.buttonText?.trim() ? [rest.buttonText.trim()] : [];
    }

    let template;
    try {
      template = await prisma.template.update({
        where: { id },
        data,
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        return reply.code(409).send({
          error: 'A template with this name and language already exists for this company',
        });
      }
      throw err;
    }
    return template;
  });

  fastify.get('/:id/insights', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const { days } = request.query as { days?: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });
    if (!existing.waTemplateId) {
      return reply.code(400).send({ error: 'This template has not been submitted to Meta yet.' });
    }

    const rangeDays = Math.min(90, Math.max(1, parseInt(days || '30', 10) || 30));
    const end = Math.floor(Date.now() / 1000);
    const start = end - rangeDays * 24 * 60 * 60;

    try {
      const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
      const dataPoints = await fetchMetaTemplateAnalytics(creds, {
        templateIds: [existing.waTemplateId],
        start,
        end,
      });

      const totals = { sent: 0, delivered: 0, read: 0, clicked: {} as Record<string, number> };
      for (const point of dataPoints) {
        totals.sent += point.sent ?? 0;
        totals.delivered += point.delivered ?? 0;
        totals.read += point.read ?? 0;
        for (const click of point.clicked ?? []) {
          const key = click.button_content || click.type;
          totals.clicked[key] = (totals.clicked[key] ?? 0) + (click.count ?? 0);
        }
      }

      return {
        templateId: existing.id,
        waTemplateId: existing.waTemplateId,
        start,
        end,
        dataPoints: dataPoints
          .map((p) => ({
            start: p.start,
            end: p.end,
            sent: p.sent ?? 0,
            delivered: p.delivered ?? 0,
            read: p.read ?? 0,
            clicked: p.clicked ?? [],
          }))
          .sort((a, b) => a.start - b.start),
        totals,
      };
    } catch (err) {
      return reply.code(400).send({ error: metaErrorMessage(err) });
    }
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
      // CAS on updatedAt — a concurrent bulk /sync for this same workspace
      // can race this single-template refresh, both fetching Meta at
      // slightly different moments and writing the same row. If the row
      // changed since we read it above, something else already wrote a
      // (presumably at-least-as-fresh) status — return that instead of
      // blindly overwriting it with what may now be the stale value.
      await prisma.template.updateMany({
        where: { id, updatedAt: existing.updatedAt },
        data: {
          status: metaStatusToSystem(mt.status),
          category: normalizeCategory(mt.category),
          language: mt.language || existing.language,
          rejectionReason: mt.rejected_reason ?? null,
          waTemplateId: mt.id ?? existing.waTemplateId,
        },
      });
      // Re-fetch regardless of whether our own write landed — this always
      // reflects whichever write actually won.
      const template = await prisma.template.findUnique({ where: { id } });
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
    if (existing.status === 'pending') {
      return reply.code(400).send({ error: 'Template is already pending review at Meta' });
    }

    // Atomic claim — only one concurrent submit for this template proceeds
    // past this point. Without it, a double-click (or a slow request plus
    // an impatient retry) both read status draft/rejected, both call
    // Meta's create-template API for the same name+language, and the
    // loser's "duplicate template" error used to overwrite the winner's
    // real status with a false 'rejected'.
    const claim = await prisma.template.updateMany({
      where: { id, workspaceId, status: { in: ['draft', 'rejected'] } },
      data: { status: 'pending' },
    });
    if (claim.count === 0) {
      return reply.code(409).send({ error: 'This template is already being submitted or reviewed' });
    }

    try {
      const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
      const components = await buildComponentsForSubmit(workspaceId, existing);
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
      await prisma.template
        .update({
          where: { id },
          data: { status: 'rejected', rejectionReason: message },
        })
        .catch(() => {});
      return reply.code(400).send({ error: message });
    }
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    const [campaignRef, paymentRef, journeyRef] = await Promise.all([
      prisma.campaign.findFirst({ where: { workspaceId, templateId: id }, select: { id: true } }),
      prisma.whatsAppPaymentRequest.findFirst({
        where: { workspaceId, templateId: id },
        select: { id: true },
      }),
      prisma.journeyNode.findFirst({
        where: { journey: { workspaceId }, data: { path: ['templateId'], equals: id } },
        select: { id: true },
      }),
    ]);
    if (campaignRef || paymentRef || journeyRef) {
      return reply.code(409).send({
        error:
          'This template is still referenced by a campaign, payment request, or journey step — remove those references first.',
      });
    }

    if (existing.waTemplateId || existing.status !== 'draft') {
      try {
        const creds = await getWorkspaceWhatsAppCredentials(workspaceId);
        await deleteMetaMessageTemplate(creds, existing.name);
      } catch (err) {
        // Don't silently delete the local row when the Meta-side delete
        // failed — the template would still be live (and billable) on
        // Meta while the app forgets it ever existed, with no way back
        // short of a full re-sync rediscovering it under a new local id.
        fastify.log.warn({ err, template: existing.name }, 'Meta template delete failed');
        return reply.code(502).send({
          error: `Could not delete this template on Meta (${metaErrorMessage(err)}). It was not removed locally — try again.`,
        });
      }
    }

    await prisma.template.delete({ where: { id } });
    return { ok: true };
  });
}
