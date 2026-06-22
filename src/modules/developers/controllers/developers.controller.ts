import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import type { DevelopersContainer } from '../container.js';
import {
  createOutgoingWebhookSchema,
  updateIncomingWebhookSchema,
  updateOutgoingWebhookSchema,
  upsertActionSchema,
  webhookLogsQuerySchema,
} from '../dto/developers.dto.js';

export class DevelopersController {
  constructor(private readonly c: DevelopersContainer) {}

  getIncomingWebhook = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.webhooksService.getIncomingWebhook(workspaceId);
  };

  updateIncomingWebhook = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const body = updateIncomingWebhookSchema.parse(request.body);
    return this.c.webhooksService.updateIncomingWebhook(workspaceId, body);
  };

  listOutgoingWebhooks = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.webhooksService.listOutgoingWebhooks(workspaceId);
  };

  createOutgoingWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = createOutgoingWebhookSchema.parse(request.body);
    const created = await this.c.webhooksService.createOutgoingWebhook(workspaceId, body);
    return reply.code(201).send(created);
  };

  updateOutgoingWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = updateOutgoingWebhookSchema.parse(request.body);
    const updated = await this.c.webhooksService.updateOutgoingWebhook(workspaceId, id, body);
    if (!updated) return reply.code(404).send({ error: 'Webhook not found' });
    return updated;
  };

  deleteOutgoingWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const ok = await this.c.webhooksService.deleteOutgoingWebhook(workspaceId, id);
    if (!ok) return reply.code(404).send({ error: 'Webhook not found' });
    return reply.code(204).send();
  };

  listWebhookLogs = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const query = webhookLogsQuerySchema.parse(request.query);
    return this.c.webhooksService.listWebhookLogs(workspaceId, query);
  };

  listActions = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.actionsService.listActions(workspaceId);
  };

  upsertAction = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const body = upsertActionSchema.parse(request.body);
    return this.c.actionsService.upsertAction(workspaceId, body);
  };

  getAiSyncDashboard = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.aiSyncDashboardService.getDashboard(workspaceId);
  };

  listAiSyncEvents = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.aiSyncDashboardService.listRecentEvents(workspaceId);
  };

  rebuildKnowledge = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      const result = await this.c.aiSyncDashboardService.requestRebuild(workspaceId);
      return reply.code(202).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rebuild failed';
      return reply.code(400).send({ error: message });
    }
  };
}

export class IncomingWebhookController {
  constructor(private readonly c: DevelopersContainer) {}

  receive = async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string };
    const secret =
      (request.headers['x-convosync-secret'] as string | undefined) ??
      (request.headers['x-webhook-secret'] as string | undefined);

    const body = (request.body ?? {}) as { event?: string; type?: string; data?: unknown };
    const result = await this.c.webhooksService.handleIncomingWebhook(slug, secret, body);

    if (!result.ok) {
      const code = result.error === 'Unauthorized' ? 401 : 404;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(200).send({ received: true });
  };
}
