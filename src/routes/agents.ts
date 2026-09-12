import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import multipart from '@fastify/multipart';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  chatWithAgent,
  getAgentConversation,
  getAgentRetrievalStats,
  getAgentTokenStats,
  testAgent,
  voicePreviewStt,
  voicePreviewTts,
} from '../modules/agents/agents-chat.controller.js';
import {
  createKnowledge,
  deleteKnowledge,
  fetchKnowledgeUrl,
  getKnowledge,
  listKnowledge,
  reindexKnowledge,
  updateKnowledge,
  uploadKnowledge,
} from '../modules/agents/agents-knowledge.controller.js';
import {
  createSkill,
  deleteSkill,
  listSkills,
  publishSkill,
  bulkCreateSkills,
  updateSkill,
} from '../modules/agents/agents-skills.controller.js';
import {
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgents,
  toggleAgent,
  updateAgent,
} from '../modules/agents/agents.controller.js';
import {
  agentChatSchema,
  agentCreateSchema,
  agentTestSchema,
  knowledgeCreateSchema,
  knowledgeFetchUrlSchema,
  knowledgeUpdateSchema,
  profileUpdateSchema,
  skillCreateSchema,
  skillUpdateSchema,
  voicePreviewTtsSchema,
} from './agents.schemas.js';

export default async function agentRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  });

  fastify.get('/', auth, listAgents);
  fastify.get('/:id', auth, getAgent);
  app.post('/', { ...auth, schema: { body: agentCreateSchema } }, createAgent);
  app.put('/:id', { ...auth, schema: { body: profileUpdateSchema } }, updateAgent);
  fastify.post('/:id/toggle', auth, toggleAgent);
  fastify.post('/:id/duplicate', auth, duplicateAgent);
  fastify.delete('/:id', auth, deleteAgent);

  app.post('/:id/chat', { ...auth, schema: { body: agentChatSchema } }, chatWithAgent);
  fastify.post('/:id/voice-preview/stt', auth, voicePreviewStt);
  app.post('/:id/voice-preview/tts', { ...auth, schema: { body: voicePreviewTtsSchema } }, voicePreviewTts);
  fastify.get('/:id/conversations/:conversationId', auth, getAgentConversation);
  fastify.get('/:id/retrieval-stats', auth, getAgentRetrievalStats);
  fastify.get('/:id/token-stats', auth, getAgentTokenStats);
  app.post('/:id/test', { ...auth, schema: { body: agentTestSchema } }, testAgent);

  fastify.get('/:id/skills', auth, listSkills);
  app.post('/:id/skills', { ...auth, schema: { body: skillCreateSchema } }, createSkill);
  fastify.post('/:id/skills/bulk', auth, bulkCreateSkills);
  app.put('/:id/skills/:skillId', { ...auth, schema: { body: skillUpdateSchema } }, updateSkill);
  fastify.patch('/:id/skills/:skillId/publish', auth, publishSkill);
  fastify.delete('/:id/skills/:skillId', auth, deleteSkill);

  fastify.get('/:id/knowledge', auth, listKnowledge);
  fastify.get('/:id/knowledge/:kId', auth, getKnowledge);
  app.post('/:id/knowledge/fetch-url', { ...auth, schema: { body: knowledgeFetchUrlSchema } }, fetchKnowledgeUrl);
  app.post('/:id/knowledge', { ...auth, schema: { body: knowledgeCreateSchema } }, createKnowledge);
  fastify.post('/:id/knowledge/upload', auth, uploadKnowledge);
  app.put('/:id/knowledge/:kId', { ...auth, schema: { body: knowledgeUpdateSchema } }, updateKnowledge);
  fastify.delete('/:id/knowledge/:kId', auth, deleteKnowledge);
  fastify.post('/:id/knowledge/reindex', auth, reindexKnowledge);
}
