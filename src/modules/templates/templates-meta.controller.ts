import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import { getWorkspaceWhatsAppCredentials } from '../../services/whatsappCredentials.js';
import { metaCategoryToSystem, metaStatusToSystem } from '../../constants/templateLabels.js';
import {
  buildMetaComponents,
  createMetaMessageTemplate,
  fetchMetaMessageTemplates,
  fetchMetaTemplateAnalytics,
  metaErrorMessage,
  normalizeMetaLanguageCode,
  parseMetaComponents,
} from '../../services/metaMessageTemplates.js';
import {
  headerFormatForMime,
  isAllowedTemplateHeaderMime,
  readTemplateHeaderMedia,
  saveTemplateHeaderMedia,
  sniffAllowedHeaderMediaType,
  uploadMetaResumableMedia,
} from '../../services/templateMedia.js';

export function normalizeCategory(category: string) {
  return metaCategoryToSystem(category);
}

export async function resolveHeaderMediaHandle(
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
export async function resolveButtonFlowRefs(
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

export async function listTemplates(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  const { sync } = request.query as { sync?: string };
  if (sync === '1' || sync === 'true') {
    try {
      await syncTemplatesFromMeta(workspaceId);
    } catch (err) {
      request.log.warn({ err }, 'Meta template sync failed');
    }
  }
  return prisma.template.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function syncTemplates(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function uploadHeaderMedia(request: FastifyRequest, reply: FastifyReply) {
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
    const storageKey = await saveTemplateHeaderMedia(workspaceId, buffer, mimeType, part.filename);
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
}

export async function getHeaderMedia(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function getTemplateInsights(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function refreshTemplateStatus(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function submitTemplate(request: FastifyRequest, reply: FastifyReply) {
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
}
