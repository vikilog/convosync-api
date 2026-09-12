import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createSchema, sendTestSchema, updateSchema } from './whatsappFlows.schemas.js';
import { prisma } from '../lib/prisma.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppFlowMessage } from '../services/whatsapp.js';
import {
  createMetaFlow,
  getMetaFlowStatus,
  MetaFlowApiError,
  publishMetaFlow,
  uploadMetaFlowJson,
} from '../services/whatsappFlowMeta.js';
import { recordFlowSend } from '../services/whatsappFlowToken.service.js';

/**
 * WhatsApp Flow CRUD + publish-to-Meta + test send (MVP: navigate-only, raw
 * Meta Flow JSON — no data-exchange endpoint). Gated server-side, not just
 * hidden in the UI — access requires Workspace.whatsappFlowsEnabled, flipped
 * manually by us after a workspace requests it (see whatsappFlowIntegration.ts).
 */
async function requireWhatsAppFlowsEnabled(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { whatsappFlowsEnabled: true },
  });
  if (!workspace?.whatsappFlowsEnabled) {
    return reply.code(403).send({
      error: 'WhatsApp Flow is not enabled for this workspace yet. Request access from Integrations.',
    });
  }
}

const flowAuth = {
  onRequest: companyAuth.onRequest,
  preHandler: requireWhatsAppFlowsEnabled,
};

function serialize(row: {
  id: string;
  name: string;
  status: string;
  flowJson: unknown;
  categories: string[];
  metaFlowId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    flowJson: row.flowJson,
    categories: row.categories,
    metaFlowId: row.metaFlowId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function whatsappFlowRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  fastify.get('/', flowAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const rows = await prisma.whatsAppFlow.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return { items: rows.map(serialize) };
  });

  fastify.get('/:id', flowAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const row = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!row) return reply.code(404).send({ error: 'Flow not found' });
    return { item: serialize(row) };
  });

  app.post('/', { ...flowAuth, schema: { body: createSchema } }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;

    const existing = await prisma.whatsAppFlow.findFirst({
      where: { workspaceId, name: body.name },
      select: { id: true },
    });
    if (existing) {
      return reply.code(409).send({ error: 'A flow with this name already exists' });
    }

    const row = await prisma.whatsAppFlow.create({
      data: {
        workspaceId,
        name: body.name,
        flowJson: body.flowJson as unknown as Prisma.InputJsonValue,
        categories: body.categories,
      },
    });
    return reply.code(201).send({ item: serialize(row) });
  });

  app.put('/:id', { ...flowAuth, schema: { body: updateSchema } }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = request.body;

    const existing = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Flow not found' });

    if (existing.status === 'published' && body.flowJson) {
      return reply.code(409).send({
        error: 'This flow is already published — create a new flow instead of editing a published one.',
      });
    }

    if (body.name && body.name !== existing.name) {
      const nameTaken = await prisma.whatsAppFlow.findFirst({
        where: { workspaceId, name: body.name, id: { not: id } },
        select: { id: true },
      });
      if (nameTaken) return reply.code(409).send({ error: 'A flow with this name already exists' });
    }

    const row = await prisma.whatsAppFlow.update({
      where: { id },
      data: {
        name: body.name ?? undefined,
        flowJson: body.flowJson
          ? (body.flowJson as unknown as Prisma.InputJsonValue)
          : undefined,
        categories: body.categories ?? undefined,
      },
    });
    return { item: serialize(row) };
  });

  fastify.delete('/:id', flowAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Flow not found' });

    await prisma.whatsAppFlow.delete({ where: { id } });
    return { ok: true };
  });

  // Creates the Flow on Meta (if not already), uploads the JSON asset, then
  // publishes it. Irreversible on Meta's side — the JSON can't be edited
  // after this, only re-published as a new flow.
  fastify.post('/:id/publish', flowAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    const flow = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!flow) return reply.code(404).send({ error: 'Flow not found' });
    if (flow.status === 'published') {
      return reply.code(409).send({ error: 'This flow is already published' });
    }

    const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
    if (!credentials.wabaId || !credentials.accessToken) {
      return reply.code(400).send({ error: 'WhatsApp is not connected for this workspace' });
    }

    try {
      let metaFlowId = flow.metaFlowId;
      if (!metaFlowId) {
        const created = await createMetaFlow(
          credentials.accessToken,
          credentials.wabaId,
          flow.name,
          flow.categories
        );
        metaFlowId = created.metaFlowId;
        await prisma.whatsAppFlow.update({ where: { id }, data: { metaFlowId } });
      }

      const upload = await uploadMetaFlowJson(credentials.accessToken, metaFlowId, flow.flowJson);
      if (!upload.success || upload.validationErrors.length > 0) {
        return reply.code(422).send({
          error: 'Meta rejected the flow JSON',
          validationErrors: upload.validationErrors,
        });
      }

      await publishMetaFlow(credentials.accessToken, metaFlowId);

      const row = await prisma.whatsAppFlow.update({
        where: { id },
        data: { status: 'published', metaFlowId },
      });
      return { item: serialize(row) };
    } catch (err) {
      const message = err instanceof MetaFlowApiError ? err.message : 'Failed to publish flow';
      return reply.code(502).send({ error: message });
    }
  });

  fastify.get('/:id/meta-status', flowAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const flow = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!flow) return reply.code(404).send({ error: 'Flow not found' });
    if (!flow.metaFlowId) return { status: 'not_created', validationErrors: [] };

    const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
    try {
      const status = await getMetaFlowStatus(credentials.accessToken, flow.metaFlowId);
      return status;
    } catch (err) {
      const message = err instanceof MetaFlowApiError ? err.message : 'Failed to fetch Meta status';
      return reply.code(502).send({ error: message });
    }
  });

  // Sends the published flow to one phone number outside of any journey/template —
  // for trying it out, not persisted to the inbox as a conversation message.
  app.post('/:id/send-test', { ...flowAuth, schema: { body: sendTestSchema } }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = request.body;

    const flow = await prisma.whatsAppFlow.findFirst({ where: { id, workspaceId } });
    if (!flow) return reply.code(404).send({ error: 'Flow not found' });
    if (flow.status !== 'published' || !flow.metaFlowId) {
      return reply.code(409).send({ error: 'Publish this flow before sending it' });
    }

    const screens = (flow.flowJson as { screens?: Array<{ id?: string }> })?.screens ?? [];
    const firstScreenId = screens[0]?.id;
    if (!firstScreenId) {
      return reply.code(422).send({ error: 'Flow JSON has no screens' });
    }

    const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
    if (!credentials.phoneNumberId || !credentials.accessToken) {
      return reply.code(400).send({ error: 'WhatsApp is not connected for this workspace' });
    }

    const flowToken = randomUUID();
    try {
      const result = await sendWhatsAppFlowMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        body.phone,
        {
          bodyText: body.bodyText || `Please complete: ${flow.name}`,
          metaFlowId: flow.metaFlowId,
          flowToken,
          ctaLabel: body.ctaLabel || 'Open',
          firstScreenId,
        }
      );
      await recordFlowSend({ flowToken, flowId: flow.id, workspaceId });
      return { ok: true, waMessageId: result.waMessageId };
    } catch (err) {
      return reply.code(502).send({ error: formatMetaSendError(err) });
    }
  });
}
