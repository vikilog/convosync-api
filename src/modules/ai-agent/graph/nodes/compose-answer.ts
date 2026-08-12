/**
 * Wraps hybrid/extract-answer.ts (direct), hybrid/call-llm.ts (rag/full_llm).
 * Skills apply on all paths; suggestedActions folded into the same compose LLM call.
 */
import { callLlmFull, callLlmWithRagContext } from '../../hybrid/call-llm.js';
import { extractDirectAnswer } from '../../hybrid/extract-answer.js';
import { KB_OUT_OF_SCOPE_REPLY, recoverGroundedKbReply } from '../../hybrid/kb-bound.js';
import { config } from '../../../../config.js';
import type { Intent } from '../../intent.service.js';
import type { AgentGraphStateType } from '../state.js';

function skillsBlock(skills: AgentGraphStateType['matchedSkills']): string {
  if (!skills?.length) return '';
  return (
    `\nINSTRUCTIONS FOR THIS QUERY:\n` + skills.map((s) => s.instructions).join('\n') + '\n'
  );
}

export async function composeAnswerNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  if (state.fromCache && state.reply) {
    return { suggestedActionsResolved: true, llmActions: [], llmCallCount: state.llmCallCount || 0 };
  }

  let path = state.retrievalPath || 'full_llm';
  if (path === 'escalate' && state.reply?.trim()) {
    return {
      kbChunksLoaded: 0,
      suggestedActionsResolved: true,
      llmActions: [],
    };
  }

  const agent = await state.fastify.prisma.aiAgent.findFirst({
    where: { id: state.agentId, workspaceId: state.workspaceId },
    select: { name: true, toneOfVoice: true, brandBackground: true },
  });
  const agentName = agent?.name || 'Assistant';
  const tone = agent?.toneOfVoice || 'professional';
  const brand = agent?.brandBackground ?? null;
  const history = state.history;
  const hits = state.kbChunks || [];
  const skillExtra = skillsBlock(state.matchedSkills);
  let llmCallCount = state.llmCallCount || 0;

  if (path === 'direct' && (state.matchedSkills?.length ?? 0) > 0 && hits[0]) {
    path = 'rag';
  }

  if (path === 'direct' && hits[0]) {
    let reply = extractDirectAnswer(hits[0].content, state.message);
    if (reply.trim()) {
      const guarded = recoverGroundedKbReply({
        reply,
        kbText: hits[0].content,
        message: state.message,
        extract: extractDirectAnswer,
      });
      if (guarded.escalate) {
        return {
          reply: KB_OUT_OF_SCOPE_REPLY,
          retrievalPath: 'escalate',
          kbChunksLoaded: 1,
          suggestedActionsResolved: true,
          llmActions: [],
          llmCallCount,
        };
      }
      return {
        reply: guarded.reply,
        kbChunksLoaded: 1,
        retrievalPath: 'direct',
        suggestedActionsResolved: true,
        llmActions: [],
        llmCallCount,
      };
    }
    path = 'rag';
  }

  if (path === 'rag') {
    const rag = await callLlmWithRagContext({
      llm: state.llm,
      workspaceId: state.workspaceId,
      agentName,
      toneOfVoice: tone,
      brandBackground: `${brand || ''}${skillExtra}`.trim() || null,
      message: state.message,
      hits,
      history,
      minScore: state.similarityLowThreshold ?? config.ai.similarityLowThreshold,
      withSuggestedActions: true,
    });
    llmCallCount += rag.llmCalls ?? 1;
    return {
      reply: rag.content || KB_OUT_OF_SCOPE_REPLY,
      promptTokens: (state.promptTokens || 0) + rag.promptTokens,
      completionTokens: (state.completionTokens || 0) + rag.completionTokens,
      kbChunksLoaded: rag.kbChunksLoaded,
      retrievalPath: rag.escalate ? 'escalate' : 'rag',
      skillsLoaded: state.skillsLoaded?.length ? state.skillsLoaded : rag.skillsLoaded,
      llmActions: rag.suggestedActions || [],
      suggestedActionsResolved: true,
      llmCallCount,
    };
  }

  if (path === 'escalate') {
    return {
      reply: state.reply || KB_OUT_OF_SCOPE_REPLY,
      kbChunksLoaded: 0,
      suggestedActionsResolved: true,
      llmActions: [],
      llmCallCount,
    };
  }

  const full = await callLlmFull({
    fastify: state.fastify,
    llm: state.llm,
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    intent: (state.intent || 'general') as Intent,
    stage: state.stage,
    message: state.message,
    history,
    withSuggestedActions: true,
  });
  llmCallCount += full.llmCalls ?? 1;

  return {
    reply: full.content || 'Sorry, kuch galat hua. Please dobara try karein.',
    promptTokens: (state.promptTokens || 0) + full.promptTokens,
    completionTokens: (state.completionTokens || 0) + full.completionTokens,
    kbChunksLoaded: full.kbChunksLoaded,
    skillsLoaded: Array.from(new Set([...(state.skillsLoaded || []), ...full.skillsLoaded])),
    retrievalPath: full.escalate ? 'escalate' : 'full_llm',
    llmActions: full.suggestedActions || [],
    suggestedActionsResolved: true,
    llmCallCount,
  };
}
