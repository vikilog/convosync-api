import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import {
  isMediaCapabilityRefusal,
  mediaNoMatchReply,
  mediaSendAck,
  shouldAutoSendMedia,
  shouldConsiderMediaAttachment,
} from './media/media-offer.js';
import { planAgentMediaAttachment, type MediaPlan } from './media/send-media.service.js';
import { classifyIntent, INTENTS, looksLikeMediaRequest } from './intent.service.js';
import { TokenTrackerService } from './token-tracker.service.js';
import { IdleTimeoutService } from './idle-timeout.service.js';
import { AiProviderConfigService } from './services/ai-provider-config.service.js';
import { LlmClient, LlmClientError } from './services/llm-client.service.js';
import { handleAIAgentQuery } from './hybrid/handle-ai-agent-query.js';
import type { RetrievalPath } from './hybrid/types.js';
import { executeActions, type AgentAction } from './actions/action-executor.js';
import { getRuleBasedActions } from './actions/rule-based-actions.js';
import { getLlmSuggestedActions } from './actions/llm-suggested-actions.js';
import { runAgentGraph } from './graph/agent-graph.js';

export type ChatMediaAttachment =
  | { action: 'send'; mediaId: string; title: string; type: string }
  | { action: 'offer'; mediaId: string; title: string; type: string; offerLine: string }
  | { action: 'none' };

export class ConversationService {
  private tokenTracker: TokenTrackerService;
  private idleTimeout: IdleTimeoutService;
  private providerConfig: AiProviderConfigService;

  constructor(private fastify: FastifyInstance) {
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
    /** Inbox Conversation id — used for media dedupe / WhatsApp send planning. */
    mediaConversationId?: string;
  }): Promise<{
    reply: string;
    conversationId: string;
    fromCache: boolean;
    tokensUsed: number;
    costInr: number;
    intent: string;
    stage: string;
    billingMode?: 'convosync' | 'byok';
    retrievalPath?: RetrievalPath;
    topScore?: number | null;
    mediaAttachment: ChatMediaAttachment;
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
        mediaAttachment: { action: 'none' },
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
      const isInboxChannel = (params.channel || conversation.channel || '').startsWith('inbox:');
      if (!isInboxChannel) {
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
            mediaAttachment: { action: 'none' },
          };
        }
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
        mediaAttachment: { action: 'none' },
      };
    }

    const mediaConvId = params.mediaConversationId || conversation.id;
    const previewChannel = (params.channel || conversation.channel || '') === 'preview';

    // Explicit file/image ask — skip LLM (prevents "capability nahi" / false human escalate).
    if (looksLikeMediaRequest(params.message)) {
      const plan = await planAgentMediaAttachment({
        workspaceId: params.workspaceId,
        conversationId: mediaConvId,
        query: params.message,
        intent: INTENTS.MEDIA_REQUEST,
        audience: 'customer',
      });
      const { reply, mediaAttachment } = this.replyFromMediaPlan(plan, {
        preview: previewChannel,
        forceAck: true,
        intent: INTENTS.MEDIA_REQUEST,
      });
      await this.saveMessage(conversation.id, 'user', params.message, 0, INTENTS.MEDIA_REQUEST);
      await this.saveMessage(conversation.id, 'assistant', reply, 0, INTENTS.MEDIA_REQUEST);
      await this.prisma.agentChatConversation.update({
        where: { id: conversation.id },
        data: {
          stage: 'intent_identified',
          detectedIntent: INTENTS.MEDIA_REQUEST,
          // +2: one AgentChatMessage row for the user turn, one for the assistant reply
          // (messageCount tracks raw row count — matches ai-agent-inbox-seed.service.ts).
          messageCount: { increment: 2 },
        },
      });
      return {
        reply,
        conversationId: conversation.id,
        fromCache: false,
        tokensUsed: 0,
        costInr: 0,
        intent: INTENTS.MEDIA_REQUEST,
        stage: 'intent_identified',
        billingMode,
        retrievalPath: 'full_llm',
        topScore: null,
        mediaAttachment,
      };
    }

    // ── LangGraph path (feature-flagged) ───────────────────────────────────
    if (config.ai.useLangGraph) {
      return this.chatViaLangGraph({
        params,
        llm,
        billingMode,
        conversation,
        mediaConvId,
      });
    }

    const recentContext = conversation.messages
      .slice(-2)
      .map((m) => m.content)
      .join(' ');

    let { intent, tokensUsed: intentTokens } = await classifyIntent(
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

    if (intent === INTENTS.HUMAN_REQUEST && !looksLikeMediaRequest(params.message)) {
      const reply =
        'Bilkul! Main aapko abhi ek human agent se connect karta hun. Thoda wait karein. 🙏';
      await this.saveMessage(conversation.id, 'user', params.message, 0, intent);
      await this.saveMessage(conversation.id, 'assistant', reply, 0, intent);
      await this.prisma.agentChatConversation.update({
        where: { id: conversation.id },
        data: { messageCount: { increment: 2 } },
      });
      // Escalate must run even though this path skips hybrid.
      await this.runPostReplyActions({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        channel: params.channel || conversation.channel,
        mediaConversationId: params.mediaConversationId,
        intent,
        retrievalPath: 'escalate',
        message: params.message,
        reply,
        llm,
        allowLlmSuggestions: false,
      });
      return {
        reply,
        conversationId: conversation.id,
        fromCache: true,
        tokensUsed: intentTokens,
        costInr: 0,
        intent,
        stage: 'resolution',
        billingMode,
        retrievalPath: 'escalate',
        topScore: null,
        mediaAttachment: { action: 'none' },
      };
    }
    if (intent === INTENTS.HUMAN_REQUEST && looksLikeMediaRequest(params.message)) {
      intent = INTENTS.MEDIA_REQUEST;
    }

    const stage = this.determineStage(conversation, intent);
    const conversationHistory = conversation.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const hybrid = await handleAIAgentQuery({
      fastify: this.fastify,
      llm,
      input: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        message: params.message,
        intent,
        stage,
        conversationHistory,
      },
    });

    let reply = hybrid.reply || 'Sorry, kuch galat hua. Please dobara try karein.';
    let mediaAttachment: ChatMediaAttachment = { action: 'none' };

    const skipMedia = !shouldConsiderMediaAttachment(intent, params.message);
    if (!skipMedia) {
      const plan = await planAgentMediaAttachment({
        workspaceId: params.workspaceId,
        conversationId: mediaConvId,
        query: params.message,
        intent,
        audience: 'customer',
      });
      const shaped = this.replyFromMediaPlan(plan, {
        preview: previewChannel,
        forceAck: false,
        baseReply: reply,
        intent,
      });
      reply = shaped.reply;
      mediaAttachment = shaped.mediaAttachment;
      if (isMediaCapabilityRefusal(reply) && mediaAttachment.action !== 'none') {
        reply =
          mediaAttachment.action === 'send'
            ? mediaSendAck(mediaAttachment.title)
            : mediaAttachment.offerLine;
      }
    }

    const { costInr } = await this.tokenTracker.logUsage({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: conversation.id,
      inputTokens: hybrid.promptTokens,
      outputTokens: hybrid.completionTokens,
      fromCache: hybrid.fromCache,
      intentDetected: `hybrid:${hybrid.path}`,
      skillsLoaded: hybrid.skillsLoaded,
      kbChunksLoaded: hybrid.kbChunksLoaded,
      billingMode,
    });

    await this.saveMessage(conversation.id, 'user', params.message, 0, intent);
    await this.saveMessage(
      conversation.id,
      'assistant',
      reply,
      hybrid.promptTokens + hybrid.completionTokens,
      intent,
      hybrid.fromCache
    );

    await this.prisma.agentChatConversation.update({
      where: { id: conversation.id },
      data: { stage, detectedIntent: intent, messageCount: { increment: 2 } },
    });

    // Actions never block the chat reply (errors logged inside).
    // Skip LLM suggestions on cache/direct — cheap FAQ hits shouldn't pay another LLM call.
    await this.runPostReplyActions({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      channel: params.channel || conversation.channel,
      mediaConversationId: params.mediaConversationId,
      intent,
      retrievalPath: hybrid.path,
      message: params.message,
      reply,
      llm,
      allowLlmSuggestions: hybrid.path !== 'cache' && hybrid.path !== 'direct',
    });

    return {
      reply,
      conversationId: conversation.id,
      fromCache: hybrid.fromCache,
      tokensUsed: hybrid.promptTokens + hybrid.completionTokens + intentTokens,
      costInr: hybrid.fromCache ? 0 : costInr,
      intent,
      stage,
      billingMode,
      retrievalPath: hybrid.path,
      topScore: hybrid.topScore,
      mediaAttachment,
    };
  }

  /**
   * LangGraph orchestration (AI_AGENT_USE_LANGGRAPH=true). Same return contract as legacy chat().
   */
  private async chatViaLangGraph(args: {
    params: {
      workspaceId: string;
      agentId: string;
      conversationId?: string;
      message: string;
      channel?: string;
      mediaConversationId?: string;
    };
    llm: LlmClient;
    billingMode: 'convosync' | 'byok';
    conversation: {
      id: string;
      channel: string;
      stage: string;
      messageCount: number;
      messages: Array<{ role: string; content: string }>;
      contactId?: string | null;
    };
    mediaConvId: string;
  }): Promise<{
    reply: string;
    conversationId: string;
    fromCache: boolean;
    tokensUsed: number;
    costInr: number;
    intent: string;
    stage: string;
    billingMode?: 'convosync' | 'byok';
    retrievalPath?: RetrievalPath;
    topScore?: number | null;
    mediaAttachment: ChatMediaAttachment;
  }> {
    const { params, llm, billingMode, conversation, mediaConvId } = args;
    const channel = params.channel || conversation.channel || 'preview';
    const stage = this.determineStage(conversation, 'general');
    const history = conversation.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const target = await this.resolveInboxActionTarget({
      workspaceId: params.workspaceId,
      channel,
      mediaConversationId: params.mediaConversationId,
    });

    const graphResult = await runAgentGraph({
      fastify: this.fastify,
      llm,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: conversation.id,
      contactId: target?.contactId ?? conversation.contactId ?? null,
      message: params.message,
      history,
      stage,
      channel,
      mediaConversationId: params.mediaConversationId || mediaConvId,
    });

    const finalStage = this.determineStage(conversation, graphResult.intent);

    const { costInr } = await this.tokenTracker.logUsage({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: conversation.id,
      inputTokens: graphResult.promptTokens,
      outputTokens: graphResult.completionTokens,
      fromCache: graphResult.fromCache,
      intentDetected: `langgraph:${graphResult.retrievalPath ?? 'unknown'}`,
      skillsLoaded: graphResult.skillsLoaded,
      kbChunksLoaded: graphResult.kbChunksLoaded,
      billingMode,
    });

    await this.saveMessage(conversation.id, 'user', params.message, 0, graphResult.intent);
    await this.saveMessage(
      conversation.id,
      'assistant',
      graphResult.reply,
      graphResult.promptTokens + graphResult.completionTokens,
      graphResult.intent,
      graphResult.fromCache
    );

    await this.prisma.agentChatConversation.update({
      where: { id: conversation.id },
      data: {
        stage: finalStage,
        detectedIntent: graphResult.intent,
        messageCount: { increment: 2 },
      },
    });

    return {
      reply: graphResult.reply,
      conversationId: conversation.id,
      fromCache: graphResult.fromCache,
      tokensUsed: graphResult.promptTokens + graphResult.completionTokens,
      costInr: graphResult.fromCache ? 0 : costInr,
      intent: graphResult.intent,
      stage: finalStage,
      billingMode,
      retrievalPath: graphResult.retrievalPath,
      topScore: graphResult.topScore,
      mediaAttachment: graphResult.mediaAttachment,
    };
  }

  /**
   * Inbox-only side effects (escalate / close / tags). Preview chats have no Contact row.
   * Failures are logged and never thrown to the caller.
   */
  private async runPostReplyActions(params: {
    workspaceId: string;
    agentId: string;
    channel?: string;
    mediaConversationId?: string;
    intent: string;
    retrievalPath: string;
    message: string;
    reply: string;
    llm: LlmClient;
    allowLlmSuggestions: boolean;
  }): Promise<void> {
    try {
      const target = await this.resolveInboxActionTarget(params);
      if (!target) return;

      const intentForRules = params.intent || 'unknown';
      const ruleActions = getRuleBasedActions({
        intent: intentForRules,
        retrievalPath: params.retrievalPath,
        message: params.message,
      });

      const hasTerminal = ruleActions.some(
        (a) => a.type === 'escalate_to_human' || a.type === 'close_conversations'
      );

      let llmActions: AgentAction[] = [];
      if (params.allowLlmSuggestions && !hasTerminal && intentForRules !== 'unknown') {
        try {
          llmActions = await getLlmSuggestedActions({
            message: params.message,
            reply: params.reply,
            llmClient: params.llm,
            workspaceId: params.workspaceId,
          });
        } catch (err) {
          console.warn(
            '[ConversationService] llm suggested actions failed',
            err instanceof Error ? err.message : err
          );
        }
      }

      const allActions = [...ruleActions, ...llmActions];
      if (allActions.length === 0) return;

      await executeActions(allActions, {
        prisma: this.prisma,
        workspaceId: params.workspaceId,
        conversationId: target.conversationId,
        contactId: target.contactId,
        agentId: params.agentId,
        intent: intentForRules,
        triggerReason: `Auto: ${intentForRules}`,
      });
    } catch (err) {
      console.error(
        '[ConversationService] action execution failed',
        err instanceof Error ? err.message : err
      );
    }
  }

  private async resolveInboxActionTarget(params: {
    workspaceId: string;
    channel?: string;
    mediaConversationId?: string;
  }): Promise<{ conversationId: string; contactId: string } | null> {
    const channel = params.channel || '';
    const inboxId =
      params.mediaConversationId ||
      (channel.startsWith('inbox:') ? channel.slice('inbox:'.length) : null);
    if (!inboxId) return null;

    const inbox = await this.prisma.conversation.findFirst({
      where: { id: inboxId, workspaceId: params.workspaceId },
      select: { id: true, contactId: true },
    });
    if (!inbox?.contactId) return null;
    return { conversationId: inbox.id, contactId: inbox.contactId };
  }

  private replyFromMediaPlan(
    plan: MediaPlan,
    opts: { preview: boolean; forceAck: boolean; baseReply?: string; intent?: string }
  ): { reply: string; mediaAttachment: ChatMediaAttachment } {
    if (plan.kind === 'send') {
      const title = plan.asset.title;
      let reply: string;
      if (opts.preview) {
        reply = `${opts.baseReply || mediaSendAck(title)}\n\n📎 Will send on WhatsApp: ${title} (${plan.asset.type})`;
      } else if (opts.forceAck || !opts.baseReply) {
        reply = mediaSendAck(title);
      } else {
        // e.g. pricing Q&A — keep text answer; WhatsApp inbound attaches the file.
        reply = opts.baseReply;
      }
      return {
        reply,
        mediaAttachment: {
          action: 'send',
          mediaId: plan.asset.id,
          title,
          type: plan.asset.type,
        },
      };
    }
    if (plan.kind === 'offer') {
      const base = opts.forceAck || !opts.baseReply ? plan.offerLine : `${opts.baseReply}\n\n${plan.offerLine}`;
      return {
        reply: base,
        mediaAttachment: {
          action: 'offer',
          mediaId: plan.asset.id,
          title: plan.asset.title,
          type: plan.asset.type,
          offerLine: plan.offerLine,
        },
      };
    }
    // No gallery match: keep the normal answer. Only use the gallery clarifier when
    // this turn was explicitly a media ask (forceAck / media_request|pricing intent).
    const mediaAsk = opts.forceAck || shouldAutoSendMedia(opts.intent || '');
    if (opts.baseReply?.trim()) {
      return { reply: opts.baseReply, mediaAttachment: { action: 'none' } };
    }
    return {
      reply: mediaAsk ? mediaNoMatchReply() : '',
      mediaAttachment: { action: 'none' },
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
