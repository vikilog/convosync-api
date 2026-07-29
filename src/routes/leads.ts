import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  convertLeadToContact,
  createLeadFromSocialComment,
  listLeads,
  toPublicLead,
  updateLead,
} from '../services/lead.service.js';
import {
  assertFunnelInWorkspace,
  getDefaultStageForFunnel,
} from '../services/leadFunnel.service.js';

export default async function leadsRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { source?: string; funnelId?: string };
    const leads = await listLeads(workspaceId, {
      source: query.source,
      funnelId: query.funnelId,
    });
    return { leads };
  });

  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as {
      stage?: string;
      stageId?: string;
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      requirement?: string;
      notes?: string;
    };

    try {
      const lead = await updateLead(workspaceId, id, body);
      return { lead };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post('/:id/convert-to-contact', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
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
      const message = err instanceof Error ? err.message : 'Convert failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = (request.body || {}) as {
      socialCommentId?: string;
      funnelId?: string;
      name?: string;
      requirement?: string;
      source?: string;
    };

    if (!body.funnelId) {
      return reply
        .code(400)
        .send({ error: 'funnelId is required — create a lead funnel first' });
    }

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
        const leads = await listLeads(workspaceId, { funnelId: body.funnelId });
        const lead = leads.find((l) => l.id === result.leadId) ?? null;
        return reply.send({ success: true, created: result.created, lead });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Create failed';
        return reply.code(400).send({ error: message });
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
  });
}
