import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import type { Intent } from '../intent.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
import {
  knowledgeIdsFromMatchedSkills,
  matchRelevantSkills,
} from '../context-builder.service.js';
import { recordRetrievalPath } from './analytics.js';
import { callLlmFull, callLlmWithRagContext } from './call-llm.js';
import { extractDirectAnswer } from './extract-answer.js';
import {
  KB_OUT_OF_SCOPE_REPLY,
  buildKbOutOfScopeEscalation,
  filterHitsByMinScore,
  recoverGroundedKbReply,
  isConversationalTurn,
} from './kb-bound.js';
import { checkRedisCache, setRedisCache } from './redis-cache.js';
import { retrieveKnowledgeChunks } from '../knowledge/knowledge-retrieval.js';
import { similarityLowFromEscalationRules } from './similarity-threshold.js';
import {
  decidePathAfterRetrieval,
  type HybridHit,
  type HybridQueryInput,
  type HybridQueryResult,
  type RetrievalPath,
} from './types.js';

async function skillScopedKnowledgeIds(
  fastify: FastifyInstance,
  agentId: string,
  intent: string,
  message: string
): Promise<string[] | undefined> {
  const skills = await fastify.prisma.aiSkill.findMany({
    where: { agentId, status: 'live' },
    select: { title: true, trigger: true, instructions: true, knowledgeItemIds: true },
  });
  return knowledgeIdsFromMatchedSkills(
    matchRelevantSkills({ skills, intent, message })
  );
}

function chunksToHits(
  chunks: { knowledgeItemId?: string; title: string; content: string | null; score?: number }[],
  floorScore: number
): HybridHit[] {
  return chunks
    .filter((c) => (c.content ?? '').trim())
    .map((c, i) => ({
      knowledgeItemId: c.knowledgeItemId || `kb-${i}`,
      title: c.title,
      content: c.content ?? '',
      score: c.score ?? floorScore,
    }));
}

/**
 * Hybrid orchestrator: Redis → pgvector score routing → direct / RAG / full LLM / escalate.
 * Strict KB for factual queries; greeting/farewell skip retrieval and never escalate as OOS.
 */
export async function handleAIAgentQuery(params: {
  fastify: FastifyInstance;
  llm: LlmClient;
  input: HybridQueryInput;
}): Promise<HybridQueryResult> {
  const { fastify, llm, input } = params;
  const { workspaceId, agentId, message } = input;
  const high = config.ai.similarityHighThreshold;
  const agentRow = await fastify.prisma.aiAgent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      name: true,
      toneOfVoice: true,
      brandBackground: true,
      escalationRules: true,
    },
  });
  const low = similarityLowFromEscalationRules(agentRow?.escalationRules);
  const escalateOnLow = config.ai.escalateOnLowScore;
  const conversational = isConversationalTurn(input.intent, input.stage, message);

  const cached = await checkRedisCache(fastify, { workspaceId, agentId, question: message });
  // Never serve stale escalate/OOS from Redis (path logic may have changed).
  if (cached && cached.trim() !== KB_OUT_OF_SCOPE_REPLY) {
    await finish(fastify, workspaceId, agentId, 'cache', null, 'skip');
    return {
      reply: cached,
      path: 'cache',
      fromCache: true,
      topScore: null,
      cacheable: false,
      promptTokens: 0,
      completionTokens: 0,
      kbChunksLoaded: 0,
      skillsLoaded: [],
    };
  }

  // Greetings / farewells: no KB required — ContextBuilder has dedicated prompts.
  if (conversational && input.intent !== 'human_request') {
    const full = await callLlmFull({
      fastify,
      llm,
      workspaceId,
      agentId,
      intent: input.intent as Intent,
      stage: input.stage,
      message,
      history: input.conversationHistory,
    });
    const reply =
      full.content || 'Sorry, kuch galat hua. Please dobara try karein.';
    await finish(fastify, workspaceId, agentId, 'full_llm', null, 'skip');
    return {
      reply,
      path: 'full_llm',
      fromCache: false,
      topScore: null,
      cacheable: false,
      promptTokens: full.promptTokens,
      completionTokens: full.completionTokens,
      kbChunksLoaded: full.kbChunksLoaded,
      skillsLoaded: full.skillsLoaded,
    };
  }

  const knowledgeItemIds = await skillScopedKnowledgeIds(
    fastify,
    agentId,
    input.intent,
    message
  );

  const fallbackItems = await fastify.prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId, status: 'ready' },
    select: { id: true, title: true, content: true },
  });

  const { chunks, source } = await retrieveKnowledgeChunks({
    workspaceId,
    agentId,
    query: message,
    fallbackItems,
    topK: config.ai.hybridTopK,
    minScore: low,
    knowledgeItemIds,
  });

  const confidentHits = filterHitsByMinScore(chunksToHits(chunks, low), low);
  const topScore = confidentHits[0]?.score ?? null;
  let path: Exclude<RetrievalPath, 'cache'> = decidePathAfterRetrieval({
    source,
    topScore,
    high,
    low,
    escalateOnLow,
    hitCount: confidentHits.length,
  });

  let reply = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let kbChunksLoaded = 0;
  let skillsLoaded: string[] = [];

  if (path === 'direct' && confidentHits[0]) {
    reply = extractDirectAnswer(confidentHits[0].content, message);
    if (!reply.trim()) {
      path = 'rag';
    } else {
      kbChunksLoaded = 1;
      const guarded = recoverGroundedKbReply({
        reply,
        kbText: confidentHits[0].content,
        message,
        extract: extractDirectAnswer,
      });
      reply = guarded.reply;
      if (guarded.escalate) path = 'escalate';
    }
  }

  if (path === 'rag') {
    if (confidentHits.length === 0) {
      reply = buildKbOutOfScopeEscalation('low_confidence').reply;
      path = 'escalate';
    } else {
      const rag = await callLlmWithRagContext({
        llm,
        workspaceId,
        agentName: agentRow?.name ?? 'Assistant',
        toneOfVoice: agentRow?.toneOfVoice ?? 'professional',
        brandBackground: agentRow?.brandBackground ?? null,
        message,
        hits: confidentHits,
        history: input.conversationHistory,
        minScore: low,
      });
      reply = rag.content;
      promptTokens = rag.promptTokens;
      completionTokens = rag.completionTokens;
      kbChunksLoaded = rag.kbChunksLoaded;
      if (rag.escalate) path = 'escalate';
    }
  } else if (path === 'escalate') {
    reply = buildKbOutOfScopeEscalation(
      topScore != null && topScore < low ? 'low_confidence' : 'no_kb_match'
    ).reply;
  } else if (path === 'full_llm') {
    const full = await callLlmFull({
      fastify,
      llm,
      workspaceId,
      agentId,
      intent: input.intent as Intent,
      stage: input.stage,
      message,
      history: input.conversationHistory,
    });
    reply =
      full.content || 'Sorry, kuch galat hua. Please dobara try karein.';
    promptTokens = full.promptTokens;
    completionTokens = full.completionTokens;
    kbChunksLoaded = full.kbChunksLoaded;
    skillsLoaded = full.skillsLoaded;
    if (full.escalate) path = 'escalate';
  }

  const cacheable =
    path === 'direct' || path === 'rag' || (topScore != null && topScore >= low);

  if (cacheable && reply.trim() && reply.trim() !== KB_OUT_OF_SCOPE_REPLY) {
    await setRedisCache(fastify, {
      workspaceId,
      agentId,
      question: message,
      answer: reply,
    });
  }

  await finish(fastify, workspaceId, agentId, path, topScore, source);

  return {
    reply,
    path,
    fromCache: false,
    topScore,
    cacheable,
    promptTokens,
    completionTokens,
    kbChunksLoaded,
    skillsLoaded,
  };
}

async function finish(
  fastify: FastifyInstance,
  workspaceId: string,
  agentId: string,
  path: RetrievalPath,
  topScore: number | null,
  source: 'pgvector' | 'database' | 'none' | 'skip' = 'skip'
): Promise<void> {
  console.info(
    `[HybridRetrieval] path=${path} score=${topScore ?? 'n/a'} source=${source} cache=${path === 'cache' ? 'hit' : 'miss'} agent=${agentId}`
  );
  await recordRetrievalPath(fastify, workspaceId, agentId, path);
}
