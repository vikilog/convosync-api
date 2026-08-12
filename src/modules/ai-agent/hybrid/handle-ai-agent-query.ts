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
  guardKbBoundReply,
  isConversationalTurn,
} from './kb-bound.js';
import { checkRedisCache, setRedisCache } from './redis-cache.js';
import { searchKnowledgeVectors } from './search-knowledge-vectors.js';
import {
  decideRetrievalPath,
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
  const low = config.ai.similarityLowThreshold;
  const escalateOnLow = config.ai.escalateOnLowScore;
  const conversational = isConversationalTurn(input.intent, input.stage);

  const cached = await checkRedisCache(fastify, { workspaceId, agentId, question: message });
  // Ignore stale OOS replies cached before conversational bypass (e.g. "Hello").
  if (cached && !(conversational && cached.trim() === KB_OUT_OF_SCOPE_REPLY)) {
    await finish(fastify, workspaceId, agentId, 'cache', null);
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
    await finish(fastify, workspaceId, agentId, 'full_llm', null);
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

  const search = await searchKnowledgeVectors({
    workspaceId,
    agentId,
    query: message,
    topK: config.ai.hybridTopK,
    knowledgeItemIds,
    resolvePath: (s) =>
      s.ok ? decideRetrievalPath(s.topScore, high, low, escalateOnLow) : 'escalate',
  });

  const confidentHits = filterHitsByMinScore(search.hits, low);
  const topScore = search.topScore;
  let path: Exclude<RetrievalPath, 'cache'> = !search.ok
    ? 'escalate'
    : decideRetrievalPath(
        confidentHits[0]?.score ?? (topScore != null && topScore < low ? topScore : null),
        high,
        low,
        escalateOnLow
      );

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
      const guarded = guardKbBoundReply({
        reply,
        kbText: confidentHits[0].content,
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
      const agent = await fastify.prisma.aiAgent.findFirst({
        where: { id: agentId, workspaceId },
        select: { name: true, toneOfVoice: true, brandBackground: true },
      });
      const rag = await callLlmWithRagContext({
        llm,
        workspaceId,
        agentName: agent?.name ?? 'Assistant',
        toneOfVoice: agent?.toneOfVoice ?? 'professional',
        brandBackground: agent?.brandBackground ?? null,
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

  await finish(fastify, workspaceId, agentId, path, topScore);

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
  topScore: number | null
): Promise<void> {
  console.info(
    `[HybridRetrieval] path=${path} score=${topScore ?? 'n/a'} cache=${path === 'cache' ? 'hit' : 'miss'} agent=${agentId}`
  );
  await recordRetrievalPath(fastify, workspaceId, agentId, path);
}
