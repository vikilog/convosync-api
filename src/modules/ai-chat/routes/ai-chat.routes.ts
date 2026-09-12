import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initAiKnowledgeModule } from '../../ai-knowledge/container.js';
import { AiChatController } from '../controllers/ai-chat.controller.js';
import { initAiChatModule } from '../container.js';
import { aiChatMessageSchema } from '../ai-chat.schemas.js';

export default async function aiChatRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const knowledge = initAiKnowledgeModule(prisma);
  const chat = initAiChatModule(knowledge.aiContextService);
  const controller = new AiChatController(chat);

  app.post('/message', { ...companyAuth, schema: { body: aiChatMessageSchema } }, controller.chat);
}
