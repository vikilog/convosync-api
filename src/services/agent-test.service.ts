import { prisma } from '../index.js';
import { OpenAiProvider, type OpenAiMessage } from '../modules/ai-chat/providers/openai.provider.js';
import {
  knowledgeIdsFromMatchedSkills,
  matchRelevantSkills,
} from '../modules/ai-agent/context-builder.service.js';
import { retrieveKnowledgeChunks } from '../modules/ai-agent/knowledge/knowledge-retrieval.js';
import { extractDirectAnswer } from '../modules/ai-agent/hybrid/extract-answer.js';
import {
  KB_BOUND_SYSTEM_PREFIX,
  KB_NO_MATCH_SYSTEM_PREFIX,
  recoverGroundedKbReply,
} from '../modules/ai-agent/hybrid/kb-bound.js';

type ConversationTurn = { role: 'user' | 'assistant'; content: string };

type AgentActionRow = {
  type: string;
  enabled: boolean;
  instruction: string;
};

function buildActionsBlock(actions: unknown): string {
  if (!Array.isArray(actions)) return 'No independent actions configured.';
  const enabled = (actions as AgentActionRow[]).filter((a) => a?.enabled && a.instruction?.trim());
  if (enabled.length === 0) return 'No independent actions enabled.';
  return enabled
    .map(
      (a) => `
${String(a.type).toUpperCase()}: ${a.instruction.trim()}`
    )
    .join('\n');
}

const openai = new OpenAiProvider();

function buildSkillsBlock(
  skills: { title: string; trigger: string; instructions: string; status: string }[]
): string {
  const live = skills.filter((s) => s.status === 'live');
  const source = live.length > 0 ? live : skills;
  if (source.length === 0) return 'No skills configured yet.';
  return source
    .map(
      (s) => `
SKILL: ${s.title}
TRIGGER: ${s.trigger || 'Not specified'}
INSTRUCTIONS: ${s.instructions || 'Not specified'}`
    )
    .join('\n');
}

function buildKnowledgeBlock(items: { title: string; content: string | null }[]): string {
  if (items.length === 0) return 'No knowledge items available yet.';
  return items.map((k) => `${k.title}: ${k.content ?? ''}`).join('\n');
}

export async function testAgentChat(params: {
  workspaceId: string;
  agentId: string;
  message: string;
  conversationHistory: ConversationTurn[];
}): Promise<{
  reply: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  /** True when the post-generation grounding guard replaced the model's reply. */
  guarded: boolean;
  escalate: boolean;
}> {
  const agent = await prisma.aiAgent.findFirst({
    where: { id: params.agentId, workspaceId: params.workspaceId },
    include: {
      skills: { orderBy: { createdAt: 'desc' } },
      knowledgeItems: { orderBy: { createdAt: 'desc' } },
      workspace: { select: { name: true } },
    },
  });

  if (!agent) {
    throw new AgentTestError('Agent not found', 'AGENT_NOT_FOUND', 404);
  }

  if (agent.category === 'rule_based') {
    return {
      reply:
        'This is a rule-based agent preview. Configure flows to automate responses, or switch to an AI agent type for conversational testing.',
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      guarded: false,
      escalate: false,
    };
  }

  const mainInstructions =
    agent.instructions?.trim() ||
    agent.systemPrompt?.trim() ||
    'Follow brand guidelines and assist users professionally.';

  const readyKnowledge = agent.knowledgeItems.filter((k) => k.status === 'ready');
  const matchedSkills = matchRelevantSkills({
    skills: agent.skills.map((s) => ({
      title: s.title,
      trigger: s.trigger,
      instructions: s.instructions,
      knowledgeItemIds: s.knowledgeItemIds,
    })),
    intent: 'general',
    message: params.message,
  });
  const skillKbIds = knowledgeIdsFromMatchedSkills(matchedSkills);
  const fallbackItems = skillKbIds
    ? readyKnowledge.filter((k) => skillKbIds.includes(k.id))
    : readyKnowledge;
  const { chunks: knowledgeChunks } = await retrieveKnowledgeChunks({
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    query: params.message,
    fallbackItems,
    knowledgeItemIds: skillKbIds,
    allowUnscoredDbFallback: true,
  });

  // Same KB-bound prefix the live hybrid/LangGraph reply pipeline uses (kb-bound.ts) —
  // without it, the preview lets the model answer off-topic questions from general
  // training knowledge instead of refusing, which the real pipeline never does.
  const kbBoundPrefix = knowledgeChunks.length === 0 ? KB_NO_MATCH_SYSTEM_PREFIX : KB_BOUND_SYSTEM_PREFIX;

  const systemPrompt = `${kbBoundPrefix}You are ${agent.name}, an AI assistant for ${agent.workspace.name}.

Tone: ${agent.toneOfVoice}
Language: ${agent.fallbackLanguage}

Main Instructions:
${mainInstructions}

Brand Background:
${agent.brandBackground?.trim() || agent.description?.trim() || 'Not provided.'}

ACTIONS YOU CAN PERFORM:
${buildActionsBlock(agent.actions)}

Your Skills (use these for specific scenarios):
${buildSkillsBlock(agent.skills)}

Knowledge Base:
${buildKnowledgeBlock(knowledgeChunks)}

Always respond helpfully in the user's language when possible. If you cannot answer, politely say you will connect them to a human agent.`;

  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...params.conversationHistory.map((t) => ({
      role: t.role,
      content: t.content,
    })),
    { role: 'user', content: params.message },
  ];

  const { content, tokensUsed, inputTokens, outputTokens } =
    await openai.createTextChatCompletion(messages);

  const kbText = knowledgeChunks.map((k) => `${k.title}\n${k.content ?? ''}`).join('\n');
  const guarded = recoverGroundedKbReply({
    reply: content,
    kbText,
    message: params.message,
    extract: extractDirectAnswer,
  });

  return {
    reply: guarded.reply,
    tokensUsed,
    inputTokens,
    outputTokens,
    guarded: guarded.replaced,
    escalate: guarded.escalate,
  };
}

export class AgentTestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'AgentTestError';
  }
}
