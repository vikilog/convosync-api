import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import type {
  LeadCreateBody,
  LeadIdParams,
  LeadListQuery,
  LeadUpdateBody,
} from '../../routes/leads.schemas.js';
import {
  convertLeadToContact,
  createLeadFromSocialComment,
  listLeads as listLeadRows,
  toPublicLead,
  updateLead,
} from '../../services/lead.service.js';
import {
  assertFunnelInWorkspace,
  getDefaultStageForFunnel,
} from '../../services/leadFunnel.service.js';

function catchStatus(err: unknown, fallback: string): { code: number; error: string } {
  const error = err instanceof Error ? err.message : fallback;
  return { code: /not found/i.test(error) ? 404 : 400, error };
}

export async function listLeads(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  const query = request.query as LeadListQuery;
  const leads = await listLeadRows(workspaceId, {
    source: query.source,
    funnelId: query.funnelId,
  });
  return { leads };
}

export async function patchLead(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as LeadIdParams;
  try {
    const lead = await updateLead(workspaceId, id, request.body as LeadUpdateBody);
    return { lead };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Update failed');
    return reply.code(code).send({ error });
  }
}

export async function convertLead(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as LeadIdParams;
  try {
    const result = await convertLeadToContact(workspaceId, id);
    return {
      success: true,
      created: result.created,
      contactId: result.contactId,
      lead: result.lead,
      journey: result.journey ?? null,
    };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Convert failed');
    return reply.code(code).send({ error });
  }
}

export async function createLead(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const body = request.body as LeadCreateBody;

  if (!(await assertFunnelInWorkspace(workspaceId, body.funnelId))) {
    return reply.code(400).send({ error: 'Funnel not found' });
  }

  if (body.socialCommentId) {
    try {
      const result = await createLeadFromSocialComment({
        workspaceId,
        socialCommentId: body.socialCommentId,
        funnelId: body.funnelId,
      });
      const leads = await listLeadRows(workspaceId, { funnelId: body.funnelId });
      const lead = leads.find((row) => row.id === result.leadId) ?? null;
      return reply.send({ success: true, created: result.created, lead });
    } catch (err) {
      const { error } = catchStatus(err, 'Create failed');
      return reply.code(400).send({ error });
    }
  }

  const defaultStage = await getDefaultStageForFunnel(body.funnelId);
  const lead = await prisma.lead.create({
    data: {
      workspaceId,
      funnelId: body.funnelId,
      stageId: defaultStage.id,
      stage: defaultStage.name,
      name: body.name || null,
      requirement: body.requirement || '',
      source: body.source || 'manual',
      activity: [
        {
          id: `act-${Date.now()}`,
          type: 'created',
          text: 'Lead created manually',
          at: new Date().toISOString(),
        },
      ],
    },
  });
  return { success: true, created: true, lead: toPublicLead(lead) };
}
