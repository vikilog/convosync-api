import { PrismaClient } from '@prisma/client';
import {
  retrieveKnowledgeChunks,
  lexicalMatchKnowledgeItems,
} from '../src/modules/ai-agent/knowledge/knowledge-retrieval.js';
import { decidePathAfterRetrieval } from '../src/modules/ai-agent/hybrid/types.js';
import { filterHitsByMinScore } from '../src/modules/ai-agent/hybrid/kb-bound.js';
import { similarityLowFromEscalationRules } from '../src/modules/ai-agent/hybrid/similarity-threshold.js';
import { knowledgeIndexService } from '../src/modules/ai-agent/knowledge/knowledge-index.service.js';

const p = new PrismaClient();
const agentId = 'cms4u9s4q000ip9epmen7s88e';
const agent = await p.aiAgent.findUnique({
  where: { id: agentId },
  select: { workspaceId: true, escalationRules: true },
});
const kb = await p.aiAgentKnowledgeItem.findMany({
  where: { agentId, status: 'ready' },
  select: { id: true, title: true, content: true },
});
const q = 'What is dasalon?';
console.log('embeddings enabled', knowledgeIndexService.isEnabled());
console.log(
  'lexical',
  lexicalMatchKnowledgeItems(kb, q).map((c) => ({
    title: c.title,
    score: c.score,
    len: (c.content || '').length,
  }))
);
const low = similarityLowFromEscalationRules(agent!.escalationRules);
console.log('low', low, 'rules', agent!.escalationRules);
const { chunks, source } = await retrieveKnowledgeChunks({
  workspaceId: agent!.workspaceId,
  agentId,
  query: q,
  fallbackItems: kb,
  topK: 3,
  minScore: low,
});
console.log(
  'retrieve',
  source,
  chunks.map((c) => ({ title: c.title, score: c.score, len: (c.content || '').length }))
);
const hits = filterHitsByMinScore(
  chunks
    .filter((c) => (c.content || '').trim())
    .map((c, i) => ({
      knowledgeItemId: c.knowledgeItemId || String(i),
      title: c.title,
      content: c.content || '',
      score: c.score ?? low,
    })),
  low
);
const path = decidePathAfterRetrieval({
  source,
  topScore: hits[0]?.score ?? null,
  high: 0.85,
  low,
  escalateOnLow: true,
  hitCount: hits.length,
});
console.log('path', path, 'hits', hits.length, hits[0]?.title);
await p.$disconnect();
