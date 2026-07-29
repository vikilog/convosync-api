/**
 * LangGraph agent turn state.
 * Persistence stays on AgentChatConversation / inbox Message — this is in-turn orchestration only.
 */
import { Annotation } from '@langchain/langgraph';
import type { FastifyInstance } from 'fastify';
import type { AgentAction, ActionResult } from '../actions/action-executor.js';
import type { SkillMatchInput } from '../context-builder.service.js';
import type { LlmClient } from '../services/llm-client.service.js';
import type { HybridHit, RetrievalPath } from '../hybrid/types.js';

export type AgentHistoryMessage = { role: 'user' | 'assistant'; content: string };

export type GraphMediaAttachment =
  | { action: 'send'; mediaId: string; title: string; type: string }
  | { action: 'offer'; mediaId: string; title: string; type: string; offerLine: string }
  | { action: 'none' };

export const AgentGraphState = Annotation.Root({
  workspaceId: Annotation<string>,
  agentId: Annotation<string>,
  conversationId: Annotation<string>,
  contactId: Annotation<string | null>,
  message: Annotation<string>,
  history: Annotation<AgentHistoryMessage[]>,
  stage: Annotation<string>,
  channel: Annotation<string>,
  mediaConversationId: Annotation<string | undefined>,

  intent: Annotation<string>,
  retrievalPath: Annotation<RetrievalPath | undefined>,
  topScore: Annotation<number | null>,
  kbChunks: Annotation<HybridHit[]>,
  matchedSkills: Annotation<SkillMatchInput[]>,

  reply: Annotation<string>,
  fromCache: Annotation<boolean>,
  promptTokens: Annotation<number>,
  completionTokens: Annotation<number>,
  skillsLoaded: Annotation<string[]>,
  kbChunksLoaded: Annotation<number>,

  ruleActions: Annotation<AgentAction[]>,
  llmActions: Annotation<AgentAction[]>,
  /** When true, compose already folded suggestions — skip llm_suggested_actions node. */
  suggestedActionsResolved: Annotation<boolean>,
  actionResults: Annotation<ActionResult[]>,
  mediaAttachment: Annotation<GraphMediaAttachment>,
  /** Provider LLM calls this turn (classify + compose; suggestions folded into compose). */
  llmCallCount: Annotation<number>,

  fastify: Annotation<FastifyInstance>,
  llm: Annotation<LlmClient>,
});

export type AgentGraphStateType = typeof AgentGraphState.State;
