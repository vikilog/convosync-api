import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import {
  assertInstagramAutomationAllowed,
  PlanGateError,
} from '../../../services/planUsageGuards.js';
import type { InstagramJourneyContainer } from '../container.js';
import {
  createIgJourneySchema,
  saveIgGraphSchema,
  updateIgJourneySchema,
} from '../dto/ig-journey.dto.js';

export class InstagramJourneyController {
  constructor(private readonly c: InstagramJourneyContainer) {}

  list = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.journeyService.list(workspaceId);
  };

  get = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const journey = await this.c.journeyService.get(workspaceId, id);
    if (!journey) return reply.code(404).send({ error: 'Not found' });
    return journey;
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      await assertInstagramAutomationAllowed(workspaceId);
    } catch (err) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      throw err;
    }
    const body = createIgJourneySchema.parse(request.body);
    const journey = await this.c.journeyService.create(workspaceId, body);
    return reply.code(201).send(journey);
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = updateIgJourneySchema.parse(request.body);
    const journey = await this.c.journeyService.update(workspaceId, id, body);
    if (!journey) return reply.code(404).send({ error: 'Not found' });
    return journey;
  };

  remove = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const result = await this.c.journeyService.delete(workspaceId, id);
    if (!result.count) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  };

  getGraph = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const graph = await this.c.graphService.getGraph(workspaceId, id);
    if (!graph) return reply.code(404).send({ error: 'Not found' });
    return graph;
  };

  saveGraph = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = saveIgGraphSchema.parse(request.body);
    const graph = await this.c.graphService.saveGraph(workspaceId, id, body);
    if (!graph) return reply.code(404).send({ error: 'Not found' });
    return graph;
  };

  publish = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      await assertInstagramAutomationAllowed(workspaceId);
      const journey = await this.c.journeyService.publish(workspaceId, id);
      if (!journey) return reply.code(404).send({ error: 'Not found' });
      return journey;
    } catch (err) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      const message = err instanceof Error ? err.message : 'Publish failed';
      return reply.code(400).send({ error: message });
    }
  };

  contactProgress = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const { contactId } = request.params as { contactId: string };
    // Heal missed webhook resumes before returning live steps.
    await this.c.triggerService.recoverWaitingFromRecentReplies(workspaceId, contactId);
    const progress = await this.c.progressService.getContactProgress(workspaceId, contactId);
    return progress ?? { active: false };
  };
}
