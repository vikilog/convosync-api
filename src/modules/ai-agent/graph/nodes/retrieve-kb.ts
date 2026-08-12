import { config } from '../../../../config.js';
import { knowledgeIdsFromMatchedSkills } from '../../context-builder.service.js';
import { retrieveKnowledgeChunks } from '../../knowledge/knowledge-retrieval.js';
import { decidePathAfterRetrieval, type HybridHit } from '../../hybrid/types.js';
import { filterHitsByMinScore, isConversationalTurn } from '../../hybrid/kb-bound.js';
import { similarityLowFromEscalationRules } from '../../hybrid/similarity-threshold.js';
import type { AgentGraphStateType } from '../state.js';

export async function retrieveKbNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  if (state.intent === 'human_request' || state.retrievalPath === 'escalate') {
    return { kbChunks: [], topScore: null, retrievalPath: 'escalate' };
  }
  if (isConversationalTurn(state.intent || 'general', state.stage, state.message)) {
    return { kbChunks: [], topScore: null, retrievalPath: 'full_llm' };
  }

  const high = config.ai.similarityHighThreshold;
  const agentRow = await state.fastify.prisma.aiAgent.findFirst({
    where: { id: state.agentId, workspaceId: state.workspaceId },
    select: { escalationRules: true },
  });
  const low = similarityLowFromEscalationRules(agentRow?.escalationRules);
  const escalateOnLow = config.ai.escalateOnLowScore;
  const knowledgeItemIds = knowledgeIdsFromMatchedSkills(state.matchedSkills || []);

  const fallbackItems = await state.fastify.prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId: state.agentId, status: 'ready' },
    select: { id: true, title: true, content: true },
  });

  const { chunks, source } = await retrieveKnowledgeChunks({
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    query: state.message,
    fallbackItems,
    topK: config.ai.hybridTopK,
    minScore: low,
    knowledgeItemIds,
  });

  const confidentHits: HybridHit[] = filterHitsByMinScore(
    chunks
      .filter((c) => (c.content ?? '').trim())
      .map((c, i) => ({
        knowledgeItemId: c.knowledgeItemId || `kb-${i}`,
        title: c.title,
        content: c.content ?? '',
        score: c.score ?? low,
      })),
    low
  );
  const topScore = confidentHits[0]?.score ?? null;
  const path = decidePathAfterRetrieval({
    source,
    topScore,
    high,
    low,
    escalateOnLow,
    hitCount: confidentHits.length,
  });

  console.info(
    `[HybridRetrieval] path=${path} score=${topScore ?? 'n/a'} source=${source} cache=miss agent=${state.agentId}`
  );

  return {
    kbChunks: confidentHits,
    topScore,
    retrievalPath: path,
    similarityLowThreshold: low,
  };
}
