import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import type { JourneyContainer } from '../container.js';
import {
  createJourneySchema,
  saveGraphSchema,
  triggerJourneySchema,
  updateJourneySchema,
} from '../dto/journey.dto.js';

export class JourneyController {
  constructor(private readonly c: JourneyContainer) {}

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
    const body = createJourneySchema.parse(request.body);
    const journey = await this.c.journeyService.create(workspaceId, body);
    return reply.code(201).send(journey);
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = updateJourneySchema.parse(request.body);
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
    const body = saveGraphSchema.parse(request.body);
    try {
      const graph = await this.c.graphService.saveGraph(workspaceId, id, body);
      if (!graph) return reply.code(404).send({ error: 'Not found' });
      return graph;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      return reply.code(400).send({ error: message });
    }
  };

  publish = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      const journey = await this.c.journeyService.publish(workspaceId, id);
      if (!journey) return reply.code(404).send({ error: 'Not found' });
      return journey;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed';
      return reply.code(400).send({ error: message });
    }
  };

  trigger = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = triggerJourneySchema.parse(request.body);
    return this.c.triggerService.triggerManual(workspaceId, body.event, body.contactId, body.payload);
  };

  resume = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      await this.c.engine.resumeExecution(workspaceId, id);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Resume failed';
      return reply.code(400).send({ error: message });
    }
  };

  analytics = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const journey = await this.c.journeyService.get(workspaceId, id);
    if (!journey) return reply.code(404).send({ error: 'Not found' });
    return this.c.analyticsService.getJourneyAnalytics(id);
  };

  contactProgress = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const { contactId } = request.params as { contactId: string };
    const progress = await this.c.progressService.getContactProgress(workspaceId, contactId);
    return progress ?? { active: false };
  };
}
