import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import { scopedUpdateData } from '../../middleware/workspaceScope.js';
import { getWorkspaceWhatsAppCredentials } from '../../services/whatsappCredentials.js';
import { metaStatusToSystem } from '../../constants/templateLabels.js';
import {
  buildMetaComponents,
  createMetaMessageTemplate,
  deleteMetaMessageTemplate,
  extractVariableIndexes,
  metaErrorMessage,
  normalizeMetaLanguageCode,
  sanitizeTemplateName,
} from '../../services/metaMessageTemplates.js';
import { isHeaderMediaStorageKeyOwnedByWorkspace } from '../../services/campaignHeaderMedia.js';
import type { TemplateBody, TemplateUpdateBody } from '../../routes/templates.schemas.js';
import {
  normalizeCategory,
  resolveButtonFlowRefs,
  resolveHeaderMediaHandle,
} from './templates-meta.controller.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** groupId is a free-form string field on the request body — without this check a
 * client could point it at another workspace's TemplateGroup id (same class of gap
 * assertHeaderMediaStorageKeyOwnership guards against for header media). */
async function assertGroupOwnership(workspaceId: string, groupId: string | null | undefined): Promise<void> {
  if (!groupId) return;
  const group = await prisma.templateGroup.findFirst({ where: { id: groupId, workspaceId }, select: { id: true } });
  if (!group) throw new Error('Group not found');
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

export async function getTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const template = await prisma.template.findFirst({ where: { id, workspaceId } });
  if (!template) return reply.code(404).send({ error: 'Template not found' });
  return template;
}

export async function createTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const body = request.body as TemplateBody;
  const name = sanitizeTemplateName(body.name);
  const submitToMeta = body.submitToMeta !== false;

  try {
    assertHeaderMediaStorageKeyOwnership(workspaceId, body.headerMediaStorageKey);
    await assertGroupOwnership(workspaceId, body.groupId);
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
        groupId: body.groupId ?? null,
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
}

export async function updateTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const existing = await prisma.template.findFirst({ where: { id, workspaceId } });
  if (!existing) return reply.code(404).send({ error: 'Template not found' });

  const body = request.body as TemplateUpdateBody;

  try {
    assertHeaderMediaStorageKeyOwnership(workspaceId, body.headerMediaStorageKey);
    await assertGroupOwnership(workspaceId, body.groupId);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid template' });
  }

  // Approved on Meta: name/body locked, but language (to match Meta) and groupId (pure
  // local organization, no Meta involvement) can still change.
  if (existing.status === 'approved') {
    const data: { language?: string; groupId?: string | null } = {};
    if (body.language != null && String(body.language).trim()) {
      data.language = normalizeMetaLanguageCode(body.language);
    }
    if ('groupId' in body) data.groupId = body.groupId ?? null;
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({
        error:
          'Approved templates can only update language (must match Meta) or group. Create a new template to change content.',
      });
    }
    const template = await prisma.template.update({ where: { id }, data });
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
}

export async function deleteTemplate(request: FastifyRequest, reply: FastifyReply) {
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
      request.log.warn({ err, template: existing.name }, 'Meta template delete failed');
      return reply.code(502).send({
        error: `Could not delete this template on Meta (${metaErrorMessage(err)}). It was not removed locally — try again.`,
      });
    }
  }

  await prisma.template.delete({ where: { id } });
  return { ok: true };
}
