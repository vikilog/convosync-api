/**
 * Voice-fast streaming AI Agent turn (SSE).
 * Skips serial intent LLM; streams tokens so Pipecat TTS can start early.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { ContextBuilderService } from '../modules/ai-agent/context-builder.service.js';
import { decideRetrievalPath, type RetrievalPath } from '../modules/ai-agent/hybrid/types.js';
import { searchKnowledgeVectors } from '../modules/ai-agent/hybrid/search-knowledge-vectors.js';
import { checkRedisCache, setRedisCache } from '../modules/ai-agent/hybrid/redis-cache.js';
import { extractDirectAnswer } from '../modules/ai-agent/hybrid/extract-answer.js';
import { recordRetrievalPath } from '../modules/ai-agent/hybrid/analytics.js';
import { INTENTS, type Intent } from '../modules/ai-agent/intent.service.js';
import { AiProviderConfigService } from '../modules/ai-agent/services/ai-provider-config.service.js';
import { LlmClient, LlmClientError } from '../modules/ai-agent/services/llm-client.service.js';
import { TokenTrackerService } from '../modules/ai-agent/token-tracker.service.js';

function aiAgentRuntime(): FastifyInstance {
  return { prisma, redis: getRedis() } as unknown as FastifyInstance;
}

const ESCALATE_REPLY =
  'Bilkul! Main aapko abhi ek human agent se connect karta hun. Thoda wait karein.';

const HUMAN_HEURISTIC =
  /\b(human|agent|person|representative|operator|support team|real person|insaan|insan|aadmi|agent se|baat karna|talk to (a |an )?(human|person|agent))\b/i;

export type VoiceStreamEvent =
  | { event: 'meta'; data: { agentId: string; path: RetrievalPath; topScore: number | null } }
  | { event: 'token'; data: { text: string } }
  | {
      event: 'done';
      data: { response: string; retrievalPath: RetrievalPath; agentId: string };
    }
  | { event: 'error'; data: { error: string; code: string } };

function heuristicIntent(message: string): Intent {
  if (HUMAN_HEURISTIC.test(message)) return INTENTS.HUMAN_REQUEST;
  return INTENTS.GENERAL;
}

/**
 * Async generator of SSE events for voice turns.
 */
export async function* respondAiAgentTurnStream(input: {
  workspaceId: string;
  conversationId: string;
  message: string;
}): AsyncGenerator<VoiceStreamEvent> {
  const text = input.message.trim();
  if (!text) {
    yield { event: 'error', data: { error: 'Empty message', code: 'EMPTY_MESSAGE' } };
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { assigneeType: true, assigneeId: true },
  });
  if (!conversation || conversation.assigneeType !== 'ai_agent' || !conversation.assigneeId) {
    yield {
      event: 'error',
      data: { error: 'Conversation is not assigned to an AI agent', code: 'NOT_AI_ASSIGNED' },
    };
    return;
  }

  const agentId = conversation.assigneeId;
  const agent = await prisma.aiAgent.findFirst({
    where: {
      id: agentId,
      workspaceId: input.workspaceId,
      isEnabled: true,
      isPublished: true,
      category: { in: ['ai_agent', 'responsive'] },
    },
    select: { id: true, name: true, toneOfVoice: true, brandBackground: true },
  });
  if (!agent) {
    yield {
      event: 'error',
      data: { error: 'AI agent missing, disabled, or unpublished', code: 'AGENT_UNAVAILABLE' },
    };
    return;
  }

  const fastify = aiAgentRuntime();
  let llm: LlmClient;
  let billingMode: 'convosync' | 'byok' = 'convosync';
  try {
    const resolved = await new AiProviderConfigService(prisma).resolveForWorkspace(
      input.workspaceId
    );
    llm = new LlmClient(resolved);
    billingMode = resolved.mode;
  } catch (err) {
    const message =
      err instanceof LlmClientError
        ? err.message
        : 'AI provider is not configured. Check Settings → AI Provider.';
    yield { event: 'error', data: { error: message, code: 'PROVIDER_CONFIG' } };
    return;
  }

  const channelKey = `voice:${input.conversationId}`;
  let chat = await prisma.agentChatConversation.findFirst({
    where: { workspaceId: input.workspaceId, agentId, channel: channelKey },
    orderBy: { updatedAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!chat) {
    chat = await prisma.agentChatConversation.create({
      data: {
        workspaceId: input.workspaceId,
        agentId,
        channel: channelKey,
        stage: 'greeting',
      },
      include: { messages: true },
    });
  }

  const intent = heuristicIntent(text);
  if (intent === INTENTS.HUMAN_REQUEST) {
    yield {
      event: 'meta',
      data: { agentId, path: 'escalate', topScore: null },
    };
    yield { event: 'token', data: { text: ESCALATE_REPLY } };
    await persistTurn({
      chatId: chat.id,
      userText: text,
      reply: ESCALATE_REPLY,
      intent,
      path: 'escalate',
      promptTokens: 0,
      completionTokens: 0,
      fromCache: true,
      workspaceId: input.workspaceId,
      agentId,
      billingMode,
      fastify,
      skillsLoaded: [],
      kbChunksLoaded: 0,
    });
    yield {
      event: 'done',
      data: { response: ESCALATE_REPLY, retrievalPath: 'escalate', agentId },
    };
    return;
  }

  const history = chat.messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const cached = await checkRedisCache(fastify, {
    workspaceId: input.workspaceId,
    agentId,
    question: text,
  });
  if (cached) {
    yield { event: 'meta', data: { agentId, path: 'cache', topScore: null } };
    yield { event: 'token', data: { text: cached } };
    await persistTurn({
      chatId: chat.id,
      userText: text,
      reply: cached,
      intent,
      path: 'cache',
      promptTokens: 0,
      completionTokens: 0,
      fromCache: true,
      workspaceId: input.workspaceId,
      agentId,
      billingMode,
      fastify,
      skillsLoaded: [],
      kbChunksLoaded: 0,
    });
    yield {
      event: 'done',
      data: { response: cached, retrievalPath: 'cache', agentId },
    };
    return;
  }

  const high = config.ai.similarityHighThreshold;
  const low = config.ai.voiceSimilarityLowThreshold;
  const escalateOnLow = config.ai.escalateOnLowScore;
  const voiceModel = config.ai.voiceStreamModel;
  const maxTokens = config.ai.voiceMaxOutputTokens;

  const search = await searchKnowledgeVectors({
    workspaceId: input.workspaceId,
    agentId,
    query: text,
    topK: config.ai.hybridTopK,
    resolvePath: (s) =>
      s.ok ? decideRetrievalPath(s.topScore, high, low, escalateOnLow) : 'full_llm',
  });

  let path: Exclude<RetrievalPath, 'cache'> = search.ok
    ? decideRetrievalPath(search.topScore, high, low, escalateOnLow)
    : 'full_llm';

  let reply = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let kbChunksLoaded = 0;
  let skillsLoaded: string[] = [];

  if (path === 'direct' && search.hits[0]) {
    reply = extractDirectAnswer(search.hits[0].content, text);
    if (!reply.trim()) {
      path = 'rag';
    } else {
      kbChunksLoaded = 1;
      yield { event: 'meta', data: { agentId, path: 'direct', topScore: search.topScore } };
      yield { event: 'token', data: { text: reply } };
    }
  }

  if (path === 'escalate') {
    reply = ESCALATE_REPLY;
    yield { event: 'meta', data: { agentId, path, topScore: search.topScore } };
    yield { event: 'token', data: { text: reply } };
  }

  if (path === 'rag' || path === 'full_llm') {
    yield {
      event: 'meta',
      data: { agentId, path, topScore: search.topScore },
    };

    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;

    if (path === 'rag') {
      const kbBlock = search.hits
        .map(
          (h, i) =>
            `[${i + 1}] (score=${h.score.toFixed(3)}) ${h.title}\n${h.content.slice(0, 1200)}`
        )
        .join('\n\n');
      const systemPrompt = `You are ${agent.name}, a helpful support assistant.
Tone: ${agent.toneOfVoice || 'professional'}
Business: ${agent.brandBackground || 'Help the customer using the knowledge below.'}

MATCHED KNOWLEDGE (use this to answer — do not invent facts):
${kbBlock}

RULES:
- Rephrase/adapt the knowledge to answer the user's exact question.
- Keep the reply concise for voice (max 2-3 short sentences).
- If the knowledge does not cover the question, say you will connect them with a human.`;
      messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-config.ai.maxHistoryMessages),
        { role: 'user', content: text },
      ];
      kbChunksLoaded = search.hits.length;
    } else {
      const builder = new ContextBuilderService(fastify);
      const stage =
        chat.messageCount === 0
          ? 'greeting'
          : chat.messageCount > 6
            ? 'deep'
            : chat.stage || 'intent_identified';
      const context = await builder.buildContext({
        agentId,
        workspaceId: input.workspaceId,
        intent,
        conversationHistory: history,
        currentMessage: text,
        stage,
      });
      messages = [
        { role: 'system', content: context.systemPrompt },
        ...context.messages,
        { role: 'user', content: text },
      ];
      skillsLoaded = context.skillsLoaded;
      kbChunksLoaded = context.kbChunksLoaded;
    }

    try {
      const gen = llm.streamComplete(messages, {
        maxTokens,
        temperature: path === 'rag' ? 0.5 : 0.7,
        model: voiceModel,
      });
      let next = await gen.next();
      while (!next.done) {
        const chunk = next.value.text;
        if (chunk) {
          reply += chunk;
          yield { event: 'token', data: { text: chunk } };
        }
        next = await gen.next();
      }
      const final = next.value;
      reply = final.content || reply;
      promptTokens = final.usage.promptTokens;
      completionTokens = final.usage.completionTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM stream failed';
      yield { event: 'error', data: { error: message, code: 'LLM_STREAM_FAILED' } };
      return;
    }
  }

  reply = reply.trim();
  if (!reply) {
    yield { event: 'error', data: { error: 'Empty agent reply', code: 'EMPTY_REPLY' } };
    return;
  }

  const cacheable =
    path === 'direct' || path === 'rag' || (search.topScore != null && search.topScore >= low);
  if (cacheable) {
    await setRedisCache(fastify, {
      workspaceId: input.workspaceId,
      agentId,
      question: text,
      answer: reply,
    });
  }

  console.info(
    `[HybridRetrieval] path=${path} score=${search.topScore ?? 'n/a'} cache=miss agent=${agentId} voice=stream`
  );
  await recordRetrievalPath(fastify, input.workspaceId, agentId, path);

  await persistTurn({
    chatId: chat.id,
    userText: text,
    reply,
    intent,
    path,
    promptTokens,
    completionTokens,
    fromCache: false,
    workspaceId: input.workspaceId,
    agentId,
    billingMode,
    fastify,
    skillsLoaded,
    kbChunksLoaded,
  });

  yield {
    event: 'done',
    data: { response: reply, retrievalPath: path, agentId },
  };
}

async function persistTurn(input: {
  chatId: string;
  userText: string;
  reply: string;
  intent: string;
  path: RetrievalPath;
  promptTokens: number;
  completionTokens: number;
  fromCache: boolean;
  workspaceId: string;
  agentId: string;
  billingMode: 'convosync' | 'byok';
  fastify: FastifyInstance;
  skillsLoaded: string[];
  kbChunksLoaded: number;
}) {
  const tracker = new TokenTrackerService(input.fastify);
  await tracker.logUsage({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.chatId,
    inputTokens: input.promptTokens,
    outputTokens: input.completionTokens,
    fromCache: input.fromCache,
    intentDetected: `voice:${input.path}`,
    skillsLoaded: input.skillsLoaded,
    kbChunksLoaded: input.kbChunksLoaded,
    billingMode: input.billingMode,
  });

  await prisma.agentChatMessage.create({
    data: {
      conversationId: input.chatId,
      role: 'user',
      content: input.userText,
      tokensUsed: 0,
      intent: input.intent,
      fromCache: false,
    },
  });
  await prisma.agentChatMessage.create({
    data: {
      conversationId: input.chatId,
      role: 'assistant',
      content: input.reply,
      tokensUsed: input.promptTokens + input.completionTokens,
      intent: input.intent,
      fromCache: input.fromCache,
    },
  });
  await prisma.agentChatConversation.update({
    where: { id: input.chatId },
    data: {
      detectedIntent: input.intent,
      messageCount: { increment: 2 },
    },
  });
}
