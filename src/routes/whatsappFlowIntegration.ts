import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { getJwtUser } from '../middleware/auth.js';

/**
 * WhatsApp Flow integration card: gated, no self-serve enable. A workspace
 * can only request access — whatsappFlowsEnabled is flipped by hand after
 * we review the request (which also lands in support_requests so it shows
 * up in the existing Platform Admin support-requests panel).
 */
export default async function whatsappFlowIntegrationRoutes(fastify: FastifyInstance) {
  fastify.get('/', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const workspace = await prisma.workspace.findUnique({
      where: { id: user.workspaceId },
      select: { whatsappFlowsEnabled: true, whatsappFlowsRequestedAt: true },
    });
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });

    return {
      enabled: workspace.whatsappFlowsEnabled,
      requestedAt: workspace.whatsappFlowsRequestedAt?.toISOString() ?? null,
    };
  });

  fastify.post('/request-access', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user.workspaceId || !user.userId) return reply.code(401).send({ error: 'Unauthorized' });

    const workspace = await prisma.workspace.findUnique({
      where: { id: user.workspaceId },
      select: {
        id: true,
        name: true,
        email: true,
        whatsappFlowsEnabled: true,
        whatsappFlowsRequestedAt: true,
      },
    });
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });

    // Already enabled or already requested — idempotent, just report current state.
    if (workspace.whatsappFlowsEnabled || workspace.whatsappFlowsRequestedAt) {
      return {
        enabled: workspace.whatsappFlowsEnabled,
        requestedAt: workspace.whatsappFlowsRequestedAt?.toISOString() ?? null,
      };
    }

    const requester = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true, email: true },
    });

    const now = new Date();
    await prisma.$transaction([
      prisma.workspace.update({
        where: { id: workspace.id },
        data: { whatsappFlowsRequestedAt: now },
      }),
      prisma.supportRequest.create({
        data: {
          name: requester?.name || workspace.name,
          email: requester?.email || workspace.email || 'unknown@convosync.io',
          subject: 'WhatsApp Flow access request',
          message: `Workspace "${workspace.name}" (${workspace.id}) requested access to the WhatsApp Flow integration.`,
          source: 'whatsapp_flow_request',
          status: 'new',
          workspaceId: workspace.id,
        },
      }),
    ]);

    return { enabled: false, requestedAt: now.toISOString() };
  });
}
