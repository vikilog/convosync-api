import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getJwtUser } from '../../middleware/auth.js';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import {
  getPlatformOrganizationById,
  getPlatformOrganizationStats,
  getPlatformOrganizationUsageCost,
  listPlatformOrganizations,
} from '../../services/platformOrganizations.js';
import {
  createWorkspaceImpersonationSession,
  getWorkspaceAuditTrail,
  reactivateWorkspace,
  setWorkspaceAgentEnabled,
  suspendWorkspace,
  updateWorkspaceLimits,
} from '../../services/platformOrganizationAdmin.js';
import {
  activateWorkspaceSubscription,
  extendWorkspaceTrial,
} from '../../services/trial.js';

export default async function platformOrganizationRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/stats', async () => {
    return getPlatformOrganizationStats();
  });

  fastify.get('/', async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
      })
      .parse(request.query);

    return listPlatformOrganizations(query);
  });

  fastify.get('/:id/usage-cost', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query);
    const data = await getPlatformOrganizationUsageCost(id, query.month);
    if (!data) return reply.code(404).send({ error: 'Organization not found' });
    return data;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const org = await getPlatformOrganizationById(id);
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    return org;
  });

  fastify.post('/:id/trial/extend', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        days: z.coerce.number().int().min(1).max(365),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(request.body);

    const admin = getJwtUser(request);

    try {
      const workspace = await extendWorkspaceTrial(id, {
        extraDays: body.days,
        reason: body.reason,
        platformAdminId: admin.platformAdminId,
      });
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialStartedAt: workspace.trialStartedAt?.toISOString() ?? null,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to extend trial';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const workspace = await activateWorkspaceSubscription(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to activate subscription';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/suspend', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const workspace = await suspendWorkspace(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to suspend workspace';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/reactivate', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const workspace = await reactivateWorkspace(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reactivate workspace';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/impersonate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const admin = getJwtUser(request);
    try {
      return await createWorkspaceImpersonationSession(fastify, id, admin.platformAdminId!);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to impersonate workspace';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:id/limits', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        contactsLimit: z.coerce.number().int().min(0).optional(),
        teamMembersLimit: z.coerce.number().int().min(1).optional(),
        aiAgentsLimit: z.coerce.number().int().min(0).optional(),
        channelsLimit: z.coerce.number().int().min(1).optional(),
        aiTokensIncluded: z.coerce.number().int().min(0).optional(),
        campaignsLimit: z.coerce.number().int().min(0).optional(),
        emailsLimit: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.body);

    try {
      const limits = await updateWorkspaceLimits(id, body);
      return { ok: true, limits };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update limits';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:id/agents/:agentId', async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    const body = z.object({ isEnabled: z.boolean() }).parse(request.body);

    try {
      const agent = await setWorkspaceAgentEnabled(id, agentId, body.isEnabled);
      return { ok: true, agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update agent';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/:id/audit', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await getWorkspaceAuditTrail(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load audit trail';
      return reply.code(400).send({ error: message });
    }
  });
}
