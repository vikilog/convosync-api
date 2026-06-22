import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { classifyIntent, INTENTS } from './intent.service.js';
import { ContextBuilderService } from './context-builder.service.js';
import { CacheService } from './cache.service.js';
import { TokenTrackerService } from './token-tracker.service.js';
import { IdleTimeoutService } from './idle-timeout.service.js';
import { AiProviderConfigService } from './services/ai-provider-config.service.js';
import { LlmClient, LlmClientError } from './services/llm-client.service.js';

export class ConversationService {
  private contextBuilder: ContextBuilderService;
  private cacheService: CacheService;
  private tokenTracker: TokenTrackerService;
  private idleTimeout: IdleTimeoutService;
  private providerConfig: AiProviderConfigService;

  constructor(private fastify: FastifyInstance) {
    this.contextBuilder = new ContextBuilderService(fastify);
    this.cacheService = new CacheService(fastify);
    this.tokenTracker = new TokenTrackerService(fastify);
    this.idleTimeout = new IdleTimeoutService(fastify);
    this.providerConfig = new AiProviderConfigService(fastify.prisma);
  }

  get prisma() {
    return this.fastify.prisma;
  }

  async chat(params: {
    workspaceId: string;
    agentId: string;
    conversationId?: string;
    message: string;
    channel?: string;
  }): Promise<{
    reply: string;
    conversationId: string;
    fromCache: boolean;
    tokensUsed: number;
    costInr: number;
    intent: string;
    stage: string;
    billingMode?: 'convosync' | 'byok';
  }> {
    let llm: LlmClient;
    let billingMode: 'convosync' | 'byok' = 'convosync';

    try {
      const resolved = await this.providerConfig.resolveForWorkspace(params.workspaceId);
      llm = new LlmClient(resolved);
      billingMode = resolved.mode;
    } catch (err) {
      const message =
        err instanceof LlmClientError
          ? err.message
          : 'AI provider is not configured. Check Settings → AI Provider.';
      return {
        reply: message,
        conversationId: params.conversationId || '',
        fromCache: false,
        tokensUsed: 0,
        costInr: 0,
        intent: 'config_error',
        stage: 'closed',
        billingMode,
      };
    }

    let conversation = params.conversationId
      ? await this.prisma.agentChatConversation.findFirst({
          where: {
            id: params.conversationId,
            workspaceId: params.workspaceId,
            agentId: params.agentId,
          },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        })
      : null;

    if (!conversation) {
      conversation = await this.prisma.agentChatConversation.create({
        data: {
          workspaceId: params.workspaceId,
          agentId: params.agentId,
          channel: params.channel || 'preview',
          stage: 'greeting',
        },
        include: { messages: true },
      });
    }

    if (params.conversationId) {
      const idleCheck = await this.idleTimeout.checkAndHandleIdle(conversation.id);
      if (idleCheck.action === 'close') {
        return {
          reply: 'Yeh conversation timeout ho gayi. Naya conversation shuru karein.',
          conversationId: conversation.id,
          fromCache: false,
          tokensUsed: 0,
          costInr: 0,
          intent: 'timeout',
          stage: 'closed',
          billingMode,
        };
      }
    }

    const quota = await this.tokenTracker.checkAndEnforceQuota(params.workspaceId);
    if (quota.exceeded) {
      return {
        reply:
          'AI quota limit reached for today. Please try again tomorrow or upgrade your plan.',
        conversationId: conversation.id,
        fromCache: false,
        tokensUsed: 0,
        costInr: 0,
        intent: 'quota_exceeded',
        stage: conversation.stage,
        billingMode,
      };
    }

    const recentContext = conversation.messages
      .slice(-2)
      .map((m) => m.content)
      .join(' ');

    const { intent, tokensUsed: intentTokens } = await classifyIntent(
      llm,
      params.message,
      recentContext
    );

    await this.tokenTracker.logUsage({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: conversation.id,
      inputTokens: intentTokens,
      outputTokens: 0,
      fromCache: false,
      intentDetected: `classify:${intent}`,
      skillsLoaded: [],
      kbChunksLoaded: 0,
      billingMode,
    });

    if (intent === INTENTS.HUMAN_REQUEST) {
      const reply =
        'Bilkul! Main aapko abhi ek human agent se connect karta hun. Thoda wait karein. 🙏';
      await this.saveMessage(conversation.id, 'user', params.message, 0, intent);
      await this.saveMessage(conversation.id, 'assistant', reply, 0, intent);
      return {
        reply,
        conversationId: conversation.id,
        fromCache: true,
        tokensUsed: intentTokens,
        costInr: 0,
        intent,
        stage: 'resolution',
        billingMode,
      };
    }

    const shouldCheckCache = this.cacheService.shouldCache(intent, params.message);
    if (shouldCheckCache) {
      const cached = await this.cacheService.getCachedResponse({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        question: params.message,
      });

      if (cached) {
        await this.saveMessage(conversation.id, 'user', params.message, 0, intent);
        await this.saveMessage(conversation.id, 'assistant', cached, 0, intent, true);
        return {
          reply: cached,
          conversationId: conversation.id,
          fromCache: true,
          tokensUsed: intentTokens,
          costInr: 0,
          intent,
          stage: conversation.stage,
          billingMode,
        };
      }
    }

    const stage = this.determineStage(conversation, intent);

    const conversationHistory = conversation.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const context = await this.contextBuilder.buildContext({
      agentId: params.agentId,
      workspaceId: params.workspaceId,
      intent,
      conversationHistory,
      currentMessage: params.message,
      stage,
    });

    const maxTokens = config.ai.maxOutputTokens;

    const aiResponse = await llm.complete(
      [
        { role: 'system', content: context.systemPrompt },
        ...context.messages,
        { role: 'user', content: params.message },
      ],
      { maxTokens, temperature: 0.7 }
    );

    const reply =
      aiResponse.content || 'Sorry, kuch galat hua. Please dobara try karein.';
    const usage = aiResponse.usage;

    const { costInr } = await this.tokenTracker.logUsage({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: conversation.id,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      fromCache: false,
      intentDetected: intent,
      skillsLoaded: context.skillsLoaded,
      kbChunksLoaded: context.kbChunksLoaded,
      billingMode,
    });

    await this.saveMessage(conversation.id, 'user', params.message, 0, intent);
    await this.saveMessage(
      conversation.id,
      'assistant',
      reply,
      usage.totalTokens,
      intent
    );

    await this.prisma.agentChatConversation.update({
      where: { id: conversation.id },
      data: { stage, detectedIntent: intent },
    });

    if (shouldCheckCache) {
      await this.cacheService.setCachedResponse({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        question: params.message,
        answer: reply,
        intent,
      });
    }

    return {
      reply,
      conversationId: conversation.id,
      fromCache: false,
      tokensUsed: usage.totalTokens + intentTokens,
      costInr,
      intent,
      stage,
      billingMode,
    };
  }

  private determineStage(
    conversation: { messageCount: number; stage: string },
    intent: string
  ): string {
    if (conversation.messageCount === 0) return 'greeting';
    if (['farewell', 'human_request'].includes(intent)) return 'resolution';
    if (conversation.stage === 'greeting') return 'intent_identified';
    if (conversation.messageCount > 6) return 'deep';
    return conversation.stage || 'intent_identified';
  }

  private async saveMessage(
    conversationId: string,
    role: string,
    content: string,
    tokensUsed: number,
    intent: string,
    fromCache = false
  ) {
    await this.prisma.agentChatMessage.create({
      data: { conversationId, role, content, tokensUsed, intent, fromCache },
    });
  }
}
