/**
 * LangGraph StateGraph for one AI Agent turn.
 * Reuses hybrid/actions/media helpers as nodes — no new storage layer.
 */
import { END, START, StateGraph } from '@langchain/langgraph';
import type { FastifyInstance } from 'fastify';
import type { LlmClient } from '../services/llm-client.service.js';
import type { RetrievalPath } from '../hybrid/types.js';
import {
  AgentGraphState,
  type AgentGraphStateType,
  type AgentHistoryMessage,
  type GraphMediaAttachment,
} from './state.js';
import { checkCacheNode } from './nodes/check-cache.js';
import { classifyAndRouteNode } from './nodes/classify-and-route.js';
import { retrieveKbNode } from './nodes/retrieve-kb.js';
import { selectSkillsNode } from './nodes/select-skills.js';
import { ruleBasedActionsNode } from './nodes/rule-based-actions.js';
import { composeAnswerNode } from './nodes/compose-answer.js';
import { llmSuggestedActionsNode } from './nodes/llm-suggested-actions.js';
import { executeActionsNode } from './nodes/execute-actions.js';
import { attachMediaNode } from './nodes/attach-media.js';
import { sendResponseNode } from './nodes/send-response.js';

function routeAfterCache(state: AgentGraphStateType): 'send_response' | 'classify_and_route' {
  return state.fromCache && state.reply ? 'send_response' : 'classify_and_route';
}

function routeAfterClassify(
  state: AgentGraphStateType
): 'rule_based_actions' | 'retrieve_kb' {
  if (state.intent === 'human_request' || state.retrievalPath === 'escalate') {
    return 'rule_based_actions';
  }
  return 'retrieve_kb';
}

function routeAfterRules(
  state: AgentGraphStateType
): 'compose_answer' | 'execute_actions' {
  const forced = (state.ruleActions || []).some(
    (a) => a.type === 'escalate_to_human' || a.type === 'close_conversations'
  );
  if (forced && state.reply?.trim() && state.retrievalPath === 'escalate') {
    return 'execute_actions';
  }
  return 'compose_answer';
}

function routeAfterCompose(
  state: AgentGraphStateType
): 'execute_actions' | 'llm_suggested_actions' {
  return state.suggestedActionsResolved ? 'execute_actions' : 'llm_suggested_actions';
}

const compiled = new StateGraph(AgentGraphState)
  .addNode('check_cache', checkCacheNode)
  .addNode('classify_and_route', classifyAndRouteNode)
  .addNode('retrieve_kb', retrieveKbNode)
  .addNode('select_skills', selectSkillsNode)
  .addNode('rule_based_actions', ruleBasedActionsNode)
  .addNode('compose_answer', composeAnswerNode)
  .addNode('llm_suggested_actions', llmSuggestedActionsNode)
  .addNode('execute_actions', executeActionsNode)
  .addNode('attach_media', attachMediaNode)
  .addNode('send_response', sendResponseNode)
  .addEdge(START, 'check_cache')
  .addConditionalEdges('check_cache', routeAfterCache, {
    send_response: 'send_response',
    classify_and_route: 'classify_and_route',
  })
  .addConditionalEdges('classify_and_route', routeAfterClassify, {
    rule_based_actions: 'rule_based_actions',
    retrieve_kb: 'retrieve_kb',
  })
  .addEdge('retrieve_kb', 'select_skills')
  .addEdge('select_skills', 'rule_based_actions')
  .addConditionalEdges('rule_based_actions', routeAfterRules, {
    compose_answer: 'compose_answer',
    execute_actions: 'execute_actions',
  })
  .addConditionalEdges('compose_answer', routeAfterCompose, {
    execute_actions: 'execute_actions',
    llm_suggested_actions: 'llm_suggested_actions',
  })
  .addEdge('llm_suggested_actions', 'execute_actions')
  .addEdge('execute_actions', 'attach_media')
  .addEdge('attach_media', 'send_response')
  .addEdge('send_response', END)
  .compile();

export type RunAgentGraphInput = {
  fastify: FastifyInstance;
  llm: LlmClient;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  contactId: string | null;
  message: string;
  history: AgentHistoryMessage[];
  stage: string;
  channel: string;
  mediaConversationId?: string;
};

export type RunAgentGraphResult = {
  reply: string;
  intent: string;
  stage: string;
  retrievalPath?: RetrievalPath;
  topScore: number | null;
  fromCache: boolean;
  promptTokens: number;
  completionTokens: number;
  skillsLoaded: string[];
  kbChunksLoaded: number;
  mediaAttachment: GraphMediaAttachment;
  llmCallCount?: number;
};

export async function runAgentGraph(input: RunAgentGraphInput): Promise<RunAgentGraphResult> {
  const result = await compiled.invoke({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    message: input.message,
    history: input.history,
    stage: input.stage,
    channel: input.channel,
    mediaConversationId: input.mediaConversationId,
    intent: 'unknown',
    retrievalPath: undefined,
    topScore: null,
    kbChunks: [],
    matchedSkills: [],
    reply: '',
    fromCache: false,
    promptTokens: 0,
    completionTokens: 0,
    skillsLoaded: [],
    kbChunksLoaded: 0,
    ruleActions: [],
    llmActions: [],
    suggestedActionsResolved: false,
    actionResults: [],
    mediaAttachment: { action: 'none' },
    llmCallCount: 0,
    fastify: input.fastify,
    llm: input.llm,
  });

  console.log(
    '[agent-graph] turn done',
    JSON.stringify({
      path: result.retrievalPath,
      intent: result.intent,
      llmCallCount: result.llmCallCount ?? null,
      suggestedResolved: result.suggestedActionsResolved,
      llmActions: (result.llmActions || []).map((a) => a.type),
    })
  );

  return {
    reply: result.reply || 'Sorry, kuch galat hua. Please dobara try karein.',
    intent: result.intent || 'unknown',
    stage: input.stage,
    retrievalPath: result.retrievalPath,
    topScore: result.topScore ?? null,
    fromCache: Boolean(result.fromCache),
    promptTokens: result.promptTokens || 0,
    completionTokens: result.completionTokens || 0,
    skillsLoaded: result.skillsLoaded || [],
    kbChunksLoaded: result.kbChunksLoaded || 0,
    mediaAttachment: result.mediaAttachment || { action: 'none' },
    llmCallCount: result.llmCallCount || 0,
  };
}
