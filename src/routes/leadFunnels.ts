import { FastifyInstance } from 'fastify';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  createFunnelStage,
  createLeadFunnel,
  deleteFunnelStage,
  deleteLeadFunnel,
  getFunnelInsights,
  getLeadFunnel,
  listFunnelStages,
  listLeadFunnels,
  updateFunnelStage,
  updateLeadFunnel,
} from '../services/leadFunnel.service.js';

export default async function leadFunnelsRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const funnels = await listLeadFunnels(workspaceId);
    return { funnels };
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = (request.body || {}) as {
      name?: string;
      description?: string;
      goal?: string;
    };
    try {
      const funnel = await createLeadFunnel(workspaceId, {
        name: body.name || '',
        description: body.description,
        goal: body.goal,
      });
      return reply.code(201).send({ funnel });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const funnel = await getLeadFunnel(workspaceId, id);
    if (!funnel) return reply.code(404).send({ error: 'Funnel not found' });
    return { funnel };
  });

  fastify.get('/:id/insights', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const insights = await getFunnelInsights(workspaceId, id);
    if (!insights) return reply.code(404).send({ error: 'Funnel not found' });
    return { insights };
  });

  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as {
      name?: string;
      description?: string;
      goal?: string;
    };
    try {
      const funnel = await updateLeadFunnel(workspaceId, id, body);
      return { funnel };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      await deleteLeadFunnel(workspaceId, id);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get('/:id/stages', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      const stages = await listFunnelStages(workspaceId, id);
      return { stages };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });

  fastify.post('/:id/stages', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { name?: string; isFinal?: boolean };
    try {
      const stage = await createFunnelStage(workspaceId, id, {
        name: body.name || '',
        isFinal: body.isFinal,
      });
      return reply.code(201).send({ stage });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });

  fastify.patch('/:id/stages/:stageId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, stageId } = request.params as { id: string; stageId: string };
    const body = (request.body || {}) as { name?: string; isFinal?: boolean };
    try {
      const stage = await updateFunnelStage(workspaceId, id, stageId, body);
      return { stage };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });

  fastify.delete('/:id/stages/:stageId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, stageId } = request.params as { id: string; stageId: string };
    try {
      await deleteFunnelStage(workspaceId, id, stageId);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });
}
