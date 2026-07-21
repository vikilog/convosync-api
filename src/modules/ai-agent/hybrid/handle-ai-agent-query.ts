import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import type { Intent } from '../intent.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
import { recordRetrievalPath } from './analytics.js';
import { callLlmFull, callLlmWithRagContext } from './call-llm.js';
import { extractDirectAnswer } from './extract-answer.js';
import { checkRedisCache, setRedisCache } from './redis-cache.js';
import { searchPinecone } from './search-pinecone.js';
import {
  decideRetrievalPath,
  type HybridQueryInput,
  type HybridQueryResult,
  type RetrievalPath,
} from './types.js';

const ESCALATE_REPLY =
  'Bilkul! Main aapko abhi ek human agent se connect karta hun. Thoda wait karein.';

/**
 * Hybrid orchestrator: Redis exact cache → Pinecone score routing → direct / RAG / full LLM / escalate.
 *
 * Thresholds: SIMILARITY_HIGH_THRESHOLD (direct), SIMILARITY_LOW_THRESHOLD (RAG vs full/escalate).
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

  const cached = await checkRedisCache(fastify, { workspaceId, agentId, question: message });
  if (cached) {
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

  const search = await searchPinecone({
    workspaceId,
    agentId,
    query: message,
    topK: config.ai.hybridTopK,
    resolvePath: (s) =>
      s.ok ? decideRetrievalPath(s.topScore, high, low, escalateOnLow) : 'full_llm',
  });

  // Pinecone hard failure → full LLM with ContextBuilder / DB fallback
  let path: Exclude<RetrievalPath, 'cache'> = search.ok
    ? decideRetrievalPath(search.topScore, high, low, escalateOnLow)
    : 'full_llm';

  let reply = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let kbChunksLoaded = 0;
  let skillsLoaded: string[] = [];

  if (path === 'direct' && search.hits[0]) {
    reply = extractDirectAnswer(search.hits[0].content, message);
    if (!reply.trim()) {
      path = 'rag';
    } else {
      kbChunksLoaded = 1;
    }
  }

  if (path === 'rag') {
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
      hits: search.hits,
      history: input.conversationHistory,
    });
    reply = rag.content;
    promptTokens = rag.promptTokens;
    completionTokens = rag.completionTokens;
    kbChunksLoaded = rag.kbChunksLoaded;
  } else if (path === 'escalate') {
    reply = ESCALATE_REPLY;
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
  }

  const topScore = search.topScore;
  const cacheable =
    path === 'direct' || path === 'rag' || (topScore != null && topScore >= low);

  if (cacheable && reply.trim()) {
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
