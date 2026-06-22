import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import type { AiKnowledgeContainer } from '../container.js';
import {
  aiContextQuerySchema,
  listCollectionsSchema,
  saveAiKnowledgeConfigSchema,
  syncAiKnowledgeSchema,
  syncCollectionSchema,
} from '../dto/ai-knowledge.dto.js';

export class AiKnowledgeController {
  constructor(private readonly c: AiKnowledgeContainer) {}

  getConfig = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.c.aiKnowledgeService.getConfig(workspaceId);
  };

  saveConfig = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = saveAiKnowledgeConfigSchema.parse(request.body);
    try {
      const config = await this.c.aiKnowledgeService.saveConfig(
        workspaceId,
        body.venueId,
        body.connectionString
      );
      return reply.code(200).send(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save config';
      return reply.code(400).send({ error: message });
    }
  };

  sync = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = syncAiKnowledgeSchema.parse(request.body);
    const result = await this.c.aiKnowledgeService.sync(workspaceId, body);
    return reply.code(200).send(result);
  };

  listCollections = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = listCollectionsSchema.parse(request.body);
    try {
      const result = await this.c.aiKnowledgeService.listCollections(workspaceId, body);
      return reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list collections';
      return reply.code(400).send({ error: message });
    }
  };

  syncCollection = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = syncCollectionSchema.parse(request.body);
    try {
      const result = await this.c.aiKnowledgeService.syncCollection(workspaceId, body);
      return reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to sync collection';
      return reply.code(400).send({ error: message });
    }
  };

  getByVenue = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { venueId } = request.params as { venueId: string };
    const record = await this.c.aiKnowledgeService.getByVenue(workspaceId, venueId);
    if (!record) {
      return reply.code(404).send({ error: 'No synced knowledge found for this venue' });
    }
    return record;
  };

  getContextForQuery = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = aiContextQuerySchema.parse(request.body);
    const result = await this.c.aiContextService.getContextForQuery(
      body.query,
      body.venueId,
      workspaceId
    );
    if (result.status === 'not_synced') {
      return reply.code(404).send({
        error: 'No synced knowledge found for this venue',
        ...result,
      });
    }
    return reply.code(200).send(result);
  };
}
