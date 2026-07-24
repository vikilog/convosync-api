import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import { ContextBuilderService } from '../context-builder.service.js';
import type { Intent } from '../intent.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
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
};

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

  const maxTokens = config.ai.maxOutputTokens;
  const aiResponse = await params.llm.complete(
    [
      { role: 'system', content: systemPrompt },
      ...params.history.slice(-config.ai.maxHistoryMessages),
      { role: 'user', content: params.message },
    ],
    { maxTokens, temperature: 0.5, workspaceId: params.workspaceId }
  );

  const kbText = hits.map((h) => `${h.title}\n${h.content}`).join('\n');
  const guarded = guardKbBoundReply({ reply: aiResponse.content, kbText });

  return {
    content: guarded.reply,
    promptTokens: aiResponse.usage.promptTokens,
    completionTokens: aiResponse.usage.completionTokens,
    skillsLoaded: [],
    kbChunksLoaded: hits.length,
    guarded: guarded.replaced,
    escalate: guarded.escalate,
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

  // No confident KB → do not call the model with open-ended knowledge
  // (media_request uses Send media skill; no KB required)
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
    };
  }

  const maxTokens = config.ai.maxOutputTokens;
  const aiResponse = await params.llm.complete(
    [
      { role: 'system', content: context.systemPrompt },
      ...context.messages,
      { role: 'user', content: params.message },
    ],
    { maxTokens, temperature: 0.7, workspaceId: params.workspaceId }
  );

  // Extract KB section from system prompt for grounding check when chunks were loaded
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
    promptTokens: aiResponse.usage.promptTokens,
    completionTokens: aiResponse.usage.completionTokens,
    skillsLoaded: context.skillsLoaded,
    kbChunksLoaded: context.kbChunksLoaded,
    guarded: guarded.replaced,
    escalate: guarded.escalate,
  };
}
