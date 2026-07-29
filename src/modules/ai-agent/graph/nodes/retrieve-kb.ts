/**
 * Wraps hybrid/search-knowledge-vectors.ts + hybrid/types.ts decideRetrievalPath
 * + hybrid/kb-bound.ts filterHitsByMinScore.
 */
import { config } from '../../../../config.js';
import { searchKnowledgeVectors } from '../../hybrid/search-knowledge-vectors.js';
import { decideRetrievalPath } from '../../hybrid/types.js';
import { filterHitsByMinScore, isConversationalTurn } from '../../hybrid/kb-bound.js';
import type { AgentGraphStateType } from '../state.js';

export async function retrieveKbNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  if (state.intent === 'human_request' || state.retrievalPath === 'escalate') {
    return { kbChunks: [], topScore: null, retrievalPath: 'escalate' };
  }
  if (isConversationalTurn(state.intent || 'general', state.stage)) {
    return { kbChunks: [], topScore: null, retrievalPath: 'full_llm' };
  }

  const high = config.ai.similarityHighThreshold;
  const low = config.ai.similarityLowThreshold;
  const escalateOnLow = config.ai.escalateOnLowScore;

  const search = await searchKnowledgeVectors({
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    query: state.message,
    topK: config.ai.hybridTopK,
    resolvePath: (s) =>
      s.ok ? decideRetrievalPath(s.topScore, high, low, escalateOnLow) : 'escalate',
  });

  const confidentHits = filterHitsByMinScore(search.hits, low);
  const topScore = search.topScore;
  const path = !search.ok
    ? 'escalate'
    : decideRetrievalPath(
        confidentHits[0]?.score ?? (topScore != null && topScore < low ? topScore : null),
        high,
        low,
        escalateOnLow
      );

  return {
    kbChunks: confidentHits,
    topScore,
    retrievalPath: path,
  };
}
