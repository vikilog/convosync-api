import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import { ContextBuilderService } from '../context-builder.service.js';
import type { Intent } from '../intent.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
import type { HybridHit } from './types.js';

export type LlmCallResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  skillsLoaded: string[];
  kbChunksLoaded: number;
};

/** RAG: Claude/OpenAI with only the matched Pinecone chunks as knowledge. */
export async function callLlmWithRagContext(params: {
  llm: LlmClient;
  agentName: string;
  toneOfVoice: string;
  brandBackground: string | null;
  message: string;
  hits: HybridHit[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<LlmCallResult> {
  const kbBlock = params.hits
    .map(
      (h, i) =>
        `[${i + 1}] (score=${h.score.toFixed(3)}) ${h.title}\n${h.content.slice(0, 1200)}`
    )
    .join('\n\n');

  const systemPrompt = `You are ${params.agentName}, a helpful support assistant.
Tone: ${params.toneOfVoice || 'professional'}
Business: ${params.brandBackground || 'Help the customer using the knowledge below.'}

MATCHED KNOWLEDGE (use this to answer — do not invent facts):
${kbBlock}

RULES:
- Rephrase/adapt the knowledge to answer the user's exact question and conversation tone.
- Keep the reply concise (max 3-4 sentences).
- If the knowledge does not cover the question, say you will connect them with a human.`;

  const maxTokens = config.ai.maxOutputTokens;
  const aiResponse = await params.llm.complete(
    [
      { role: 'system', content: systemPrompt },
      ...params.history.slice(-config.ai.maxHistoryMessages),
      { role: 'user', content: params.message },
    ],
    { maxTokens, temperature: 0.5 }
  );

  return {
    content: aiResponse.content,
    promptTokens: aiResponse.usage.promptTokens,
    completionTokens: aiResponse.usage.completionTokens,
    skillsLoaded: [],
    kbChunksLoaded: params.hits.length,
  };
}

/** Full LLM path via existing ContextBuilder (skills + KB retrieval fallback). */
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

  const maxTokens = config.ai.maxOutputTokens;
  const aiResponse = await params.llm.complete(
    [
      { role: 'system', content: context.systemPrompt },
      ...context.messages,
      { role: 'user', content: params.message },
    ],
    { maxTokens, temperature: 0.7 }
  );

  return {
    content: aiResponse.content,
    promptTokens: aiResponse.usage.promptTokens,
    completionTokens: aiResponse.usage.completionTokens,
    skillsLoaded: context.skillsLoaded,
    kbChunksLoaded: context.kbChunksLoaded,
  };
}
