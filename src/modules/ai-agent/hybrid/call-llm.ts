import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import { ContextBuilderService } from '../context-builder.service.js';
import type { Intent } from '../intent.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
import type { AgentAction } from '../actions/action-executor.js';
import {
  SUGGESTED_ACTIONS_SYSTEM_HINT,
  composeWithActionsSchema,
  normalizeSuggestedActions,
} from '../actions/llm-suggested-actions.js';
import {
  KB_BOUND_SYSTEM_PREFIX,
  KB_OUT_OF_SCOPE_REPLY,
  filterHitsByMinScore,
  guardKbBoundReply,
} from './kb-bound.js';
import type { HybridHit } from './types.js';

export type LlmCallResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  skillsLoaded: string[];
  kbChunksLoaded: number;
  /** True when post-gen guard replaced the model reply. */
  guarded?: boolean;
  escalate?: boolean;
  /** Populated when withSuggestedActions used a single structured LLM call. */
  suggestedActions?: AgentAction[];
  /** How many provider LLM calls this helper made (0|1). */
  llmCalls?: number;
};

async function completeReplyMaybeWithActions(params: {
  llm: LlmClient;
  workspaceId?: string;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
  maxTokens: number;
  temperature: number;
  withSuggestedActions?: boolean;
}): Promise<{ content: string; promptTokens: number; completionTokens: number; suggestedActions: AgentAction[]; llmCalls: number }> {
  const history = params.history.slice(-config.ai.maxHistoryMessages);

  if (params.withSuggestedActions) {
    try {
      const system = `${params.systemPrompt}\n\n${SUGGESTED_ACTIONS_SYSTEM_HINT}`;
      const { content, usage } = await params.llm.completeJsonSchema(
        [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: params.message },
        ],
        composeWithActionsSchema as unknown as Record<string, unknown>,
        {
          name: 'compose_with_actions',
          maxTokens: Math.max(params.maxTokens, 400),
          temperature: params.temperature,
          workspaceId: params.workspaceId,
        }
      );
      const parsed = JSON.parse(content) as { reply?: string; actions?: unknown };
      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      const suggestedActions = normalizeSuggestedActions({
        actions: Array.isArray(parsed.actions) ? (parsed.actions as never) : [],
      });
      return {
        content: reply || content,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        suggestedActions,
        llmCalls: 1,
      };
    } catch (err) {
      // Anthropic / schema failures → plain complete, no actions (no second call).
      console.warn(
        '[call-llm] compose+actions schema failed, falling back to plain complete',
        err instanceof Error ? err.message : err
      );
    }
  }

  const aiResponse = await params.llm.complete(
    [
      { role: 'system', content: params.systemPrompt },
      ...history,
      { role: 'user', content: params.message },
    ],
    {
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      workspaceId: params.workspaceId,
    }
  );
  return {
    content: aiResponse.content,
    promptTokens: aiResponse.usage.promptTokens,
    completionTokens: aiResponse.usage.completionTokens,
    suggestedActions: [],
    llmCalls: 1,
  };
}

/** RAG: LLM with only confident matched chunks as knowledge. */
export async function callLlmWithRagContext(params: {
  llm: LlmClient;
  workspaceId?: string;
  agentName: string;
  toneOfVoice: string;
  brandBackground: string | null;
  message: string;
  hits: HybridHit[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  minScore?: number;
  /** LangGraph: fold tag/attribute suggestions into the same structured call. */
  withSuggestedActions?: boolean;
}): Promise<LlmCallResult> {
  const minScore = params.minScore ?? config.ai.similarityLowThreshold;
  const hits = filterHitsByMinScore(params.hits, minScore);

  if (hits.length === 0) {
    return {
      content: KB_OUT_OF_SCOPE_REPLY,
      promptTokens: 0,
      completionTokens: 0,
      skillsLoaded: [],
      kbChunksLoaded: 0,
      guarded: true,
      escalate: true,
      suggestedActions: [],
      llmCalls: 0,
    };
  }

  const kbBlock = hits
    .map(
      (h, i) =>
        `[${i + 1}] (score=${h.score.toFixed(3)}) ${h.title}\n${h.content.slice(0, 1200)}`
    )
    .join('\n\n');

  const systemPrompt = `${KB_BOUND_SYSTEM_PREFIX}You are ${params.agentName}, a helpful support assistant.
Tone: ${params.toneOfVoice || 'professional'}
Business: ${params.brandBackground || 'Help the customer using the knowledge below.'}

MATCHED KNOWLEDGE (use this to answer — do not invent facts):
${kbBlock}

RULES:
- Rephrase/adapt the knowledge to answer the user's exact question and conversation tone.
- Keep the reply concise (max 3-4 sentences).
- If the knowledge does not cover the question, reply exactly with the out-of-scope fallback and escalate.`;

  const aiResponse = await completeReplyMaybeWithActions({
    llm: params.llm,
    workspaceId: params.workspaceId,
    systemPrompt,
    history: params.history,
    message: params.message,
    maxTokens: config.ai.maxOutputTokens,
    temperature: 0.5,
    withSuggestedActions: params.withSuggestedActions,
  });

  const kbText = hits.map((h) => `${h.title}\n${h.content}`).join('\n');
  const guarded = guardKbBoundReply({ reply: aiResponse.content, kbText });

  return {
    content: guarded.reply,
    promptTokens: aiResponse.promptTokens,
    completionTokens: aiResponse.completionTokens,
    skillsLoaded: [],
    kbChunksLoaded: hits.length,
    guarded: guarded.replaced,
    escalate: guarded.escalate,
    suggestedActions: guarded.escalate ? [] : aiResponse.suggestedActions,
    llmCalls: aiResponse.llmCalls,
  };
}

/** Full LLM path via ContextBuilder — still KB-gated + post-checked. */
export async function callLlmFull(params: {
  fastify: FastifyInstance;
  llm: LlmClient;
  workspaceId: string;
  agentId: string;
  intent: Intent;
  stage: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  withSuggestedActions?: boolean;
}): Promise<LlmCallResult> {
  const builder = new ContextBuilderService(params.fastify);
  const context = await builder.buildContext({
    agentId: params.agentId,
    workspaceId: params.workspaceId,
    intent: params.intent,
    conversationHistory: params.history,
    currentMessage: params.message,
    stage: params.stage,
  });

  if (
    context.kbChunksLoaded === 0 &&
    params.stage !== 'greeting' &&
    params.intent !== 'greeting' &&
    params.intent !== 'farewell' &&
    params.intent !== 'human_request' &&
    params.intent !== 'media_request'
  ) {
    return {
      content: KB_OUT_OF_SCOPE_REPLY,
      promptTokens: 0,
      completionTokens: 0,
      skillsLoaded: context.skillsLoaded,
      kbChunksLoaded: 0,
      guarded: true,
      escalate: true,
      suggestedActions: [],
      llmCalls: 0,
    };
  }

  const aiResponse = await completeReplyMaybeWithActions({
    llm: params.llm,
    workspaceId: params.workspaceId,
    systemPrompt: context.systemPrompt,
    history: context.messages,
    message: params.message,
    maxTokens: config.ai.maxOutputTokens,
    temperature: 0.7,
    withSuggestedActions: params.withSuggestedActions,
  });

  const kbText =
    context.kbChunksLoaded > 0
      ? (context.systemPrompt.split('KNOWLEDGE BASE:')[1] ?? '').split('\nRULES:')[0] ?? ''
      : '';

  const guarded =
    context.kbChunksLoaded === 0
      ? { reply: aiResponse.content, replaced: false, escalate: false }
      : guardKbBoundReply({ reply: aiResponse.content, kbText });

  return {
    content: guarded.reply,
    promptTokens: aiResponse.promptTokens,
    completionTokens: aiResponse.completionTokens,
    skillsLoaded: context.skillsLoaded,
    kbChunksLoaded: context.kbChunksLoaded,
    guarded: guarded.replaced,
    escalate: guarded.escalate,
    suggestedActions: guarded.escalate ? [] : aiResponse.suggestedActions,
    llmCalls: aiResponse.llmCalls,
  };
}
