import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initAiKnowledgeModule } from '../../ai-knowledge/container.js';
import { AiChatController } from '../controllers/ai-chat.controller.js';
import { initAiChatModule } from '../container.js';

export default async function aiChatRoutes(fastify: FastifyInstance) {
  const knowledge = initAiKnowledgeModule(prisma);
  const chat = initAiChatModule(knowledge.aiContextService);
  const controller = new AiChatController(chat);

  fastify.post('/message', companyAuth, controller.chat);
}
