import { FastifyInstance } from 'fastify';
import { isConversationalTurn, KB_NO_MATCH_SYSTEM_PREFIX } from './hybrid/kb-bound.js';
import { extractDirectAnswer } from './hybrid/extract-answer.js';
import { Intent, INTENT_TO_KB_TAGS, INTENT_TO_SKILLS } from './intent.service.js';
import { retrieveKnowledgeChunks } from './knowledge/knowledge-retrieval.js';

const MAX_HISTORY = parseInt(process.env.AI_MAX_HISTORY_MESSAGES || '6', 10);

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BuiltContext {
  systemPrompt: string;
  messages: ConversationMessage[];
  skillsLoaded: string[];
  kbChunksLoaded: number;
  estimatedTokens: number;
}

export type SkillMatchInput = {
  title: string;
  trigger: string;
  instructions: string;
  knowledgeItemIds?: string[];
};

/** Union of linked KB ids from matched skills; undefined = no skill scope (search all). */
export function knowledgeIdsFromMatchedSkills(
  skills: { knowledgeItemIds?: string[] | null }[]
): string[] | undefined {
  const ids = [
    ...new Set(
      skills.flatMap((s) => s.knowledgeItemIds ?? []).filter((id): id is string => Boolean(id))
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}

/** Shared skill matcher — used by ContextBuilder and LangGraph select_skills (all paths). */
export function matchRelevantSkills(params: {
  skills: SkillMatchInput[];
  intent: string;
  message: string;
}): SkillMatchInput[] {
  const relevantSkillTitles = INTENT_TO_SKILLS[params.intent] || [];
  const msg = params.message.toLowerCase();
  const msgTokens = new Set(
    msg
      .split(/[^a-z0-9\u0900-\u097f]+/)
      .filter((t) => t.length >= 4)
  );
  return params.skills.filter((skill) => {
    const skillTitle = skill.title.toLowerCase();
    const byIntent = relevantSkillTitles.some((title) => {
      const t = title.toLowerCase();
      if (!skillTitle.includes(t)) return false;
      // Multi-word pack names always map; short tags only if the user mentioned them.
      if (t.includes(' ') || t.length >= 10) return true;
      return msg.includes(t);
    });
    if (byIntent) return true;
    const hayTokens = `${skill.title} ${skill.trigger}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    return hayTokens.some((t) => msg.includes(t) || msgTokens.has(t));
  });
}

export class ContextBuilderService {
  constructor(private fastify: FastifyInstance) {}

  get prisma() {
    return this.fastify.prisma;
  }

  async buildContext(params: {
    agentId: string;
    workspaceId: string;
    intent: Intent;
    conversationHistory: ConversationMessage[];
    currentMessage: string;
    stage: string;
  }): Promise<BuiltContext> {
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: params.agentId, workspaceId: params.workspaceId },
      include: {
        skills: {
          where: { status: 'live' },
        },
        knowledgeItems: {
          where: { status: 'ready' },
        },
      },
    });

    if (!agent) throw new Error('Agent not found');

    const relevantSkills = matchRelevantSkills({
      skills: agent.skills.map((s) => ({
        title: s.title,
        trigger: s.trigger,
        instructions: s.instructions,
        knowledgeItemIds: s.knowledgeItemIds,
      })),
      intent: params.intent,
      message: params.currentMessage,
    });

    const relevantTags = INTENT_TO_KB_TAGS[params.intent] || [];
    let relevantKB = agent.knowledgeItems;

    if (relevantTags.length > 0) {
      const tagged = agent.knowledgeItems.filter((item) => {
        const metadata = item.metadata as { tags?: string[] } | null;
        const tags = metadata?.tags || [];
        return relevantTags.some(
          (tag) =>
            tags.includes(tag) ||
            item.title.toLowerCase().includes(tag) ||
            item.type === 'qna'
        );
      });
      // Tag map is advisory — never drop to empty when the agent has ready docs.
      if (tagged.length > 0) relevantKB = tagged;
    }

    const skillKbIds = knowledgeIdsFromMatchedSkills(relevantSkills);
    if (skillKbIds) {
      const allow = new Set(skillKbIds);
      const scoped = relevantKB.filter((item) => allow.has(item.id));
      // Stale/empty skill knowledgeItemIds must not zero out agent-wide KB.
      if (scoped.length > 0) relevantKB = scoped;
    }

    // greeting/farewell/human_request/media_request get a fixed prompt below
    // that never includes a KB section — skip retrieval entirely instead of
    // letting a spurious lexical-fallback match set kbChunksLoaded > 0 for a
    // prompt that has nowhere to put it (mirrors graph/nodes/retrieve-kb.ts's
    // isConversationalTurn guard, which this hybrid path lacked).
    const conversational = isConversationalTurn(
      params.intent,
      params.stage,
      params.currentMessage
    );
    const { chunks: kbChunks } = conversational
      ? { chunks: [] }
      : await retrieveKnowledgeChunks({
          workspaceId: params.workspaceId,
          agentId: params.agentId,
          query: params.currentMessage,
          fallbackItems: relevantKB,
          knowledgeItemIds: skillKbIds,
        });

    const systemPrompt = this.buildSystemPrompt({
      agent,
      intent: params.intent,
      stage: params.stage,
      relevantSkills,
      kbChunks,
      currentMessage: params.currentMessage,
    });

    const trimmedHistory = this.trimHistory(params.conversationHistory, params.stage);

    const estimatedTokens = this.estimateTokens(
      systemPrompt,
      trimmedHistory,
      params.currentMessage
    );

    return {
      systemPrompt,
      messages: trimmedHistory,
      skillsLoaded: relevantSkills.map((s) => s.title),
      kbChunksLoaded: kbChunks.length,
      estimatedTokens,
    };
  }

  private buildSystemPrompt(params: {
    agent: {
      name: string;
      brandBackground: string | null;
      toneOfVoice: string;
      fallbackLanguage: string;
    };
    intent: Intent;
    stage: string;
    relevantSkills: { title: string; instructions: string }[];
    kbChunks: { title: string; content: string | null }[];
    currentMessage: string;
  }): string {
    const { agent, intent, stage, relevantSkills, kbChunks, currentMessage } = params;

    if (stage === 'greeting' || intent === 'greeting') {
      return `You are ${agent.name}, a helpful assistant for ${agent.brandBackground || 'our company'}.
Tone: ${agent.toneOfVoice || 'professional'}
Language: ${agent.fallbackLanguage || 'english'}
Greet the user warmly and ask how you can help. Keep it to 1-2 sentences.`;
    }

    if (intent === 'farewell') {
      return `You are ${agent.name}. The user is leaving. 
Say a warm goodbye and mention they can return anytime. 1 sentence only.`;
    }

    if (intent === 'human_request') {
      return `You are ${agent.name}. The user wants to speak with a human agent.
Acknowledge their request, apologize for any inconvenience, 
and inform them that a human agent will be with them shortly.
Be empathetic. 2 sentences max.`;
    }

    if (intent === 'media_request') {
      let mediaPrompt = `You are ${agent.name}. The user is asking for a file/image.
Tone: ${agent.toneOfVoice || 'professional'}
Language: ${agent.fallbackLanguage || 'english'}

CRITICAL:
- You CAN share images/PDFs — the system attaches them from Media Gallery after your reply.
- NEVER say you lack capability to share images/files.
- NEVER escalate to a human for a media/file request.
- Reply in 1 short sentence confirming you are sending it (or checking the gallery).
`;
      if (relevantSkills.length > 0) {
        mediaPrompt += `\nINSTRUCTIONS FOR THIS QUERY:\n`;
        relevantSkills.forEach((skill) => {
          mediaPrompt += `${skill.instructions}\n`;
        });
      }
      return mediaPrompt;
    }

    // Capability asks / vague fragments ("how?", "what can you help with") skip
    // retrieval via isConversationalTurn, so kbChunks is always empty for them —
    // without this branch they'd fall into the generic KB_NO_MATCH_SYSTEM_PREFIX
    // below and refuse+escalate instead of answering or asking what they need.
    if (kbChunks.length === 0 && isConversationalTurn(intent, stage, currentMessage)) {
      return `You are ${agent.name}, a helpful assistant for ${agent.brandBackground || 'our company'}.
Tone: ${agent.toneOfVoice || 'professional'}
Language: ${agent.fallbackLanguage || 'english'}

The user's message is a general/capability question or too brief to search the knowledge base with (e.g. "how?", "what can you help with?").
Do NOT say you lack info and do NOT offer to connect them to a human for this.
Use the conversation history if it helps you understand what they mean. Either briefly explain what you can help with, or ask ONE short clarifying question to find out what they need — whichever fits their message better. Keep it to 1-2 sentences, matching their language/tone.`;
    }

    let prompt = '';

    if (kbChunks.length === 0) {
      prompt += KB_NO_MATCH_SYSTEM_PREFIX;
    }

    prompt += `You are ${agent.name}, an AI assistant.

BUSINESS:
${agent.brandBackground || 'We are here to help our customers.'}

TONE: ${agent.toneOfVoice || 'professional'}
LANGUAGE: ${agent.fallbackLanguage || 'english'}
`;

    if (relevantSkills.length > 0) {
      prompt += `\nINSTRUCTIONS FOR THIS QUERY:\n`;
      relevantSkills.forEach((skill) => {
        prompt += `${skill.instructions}\n`;
      });
    }

    if (kbChunks.length > 0) {
      prompt += `\nKNOWLEDGE BASE:\n`;
      kbChunks.forEach((chunk) => {
        const content = extractDirectAnswer(chunk.content ?? '', currentMessage).substring(0, 500);
        prompt += `${chunk.title}:\n${content}\n\n`;
      });
    }

    prompt += `\nRULES:
- Keep responses concise (max 3-4 sentences)
- Answer ONLY from the knowledge base above — never from general/training knowledge
- If knowledge base is empty or does not cover the question, use the out-of-scope fallback and escalate
- Never invent product, pricing, policy, or competitor facts`;

    return prompt;
  }

  private trimHistory(history: ConversationMessage[], stage: string): ConversationMessage[] {
    if (stage === 'greeting') return [];

    if (history.length <= MAX_HISTORY) return history;

    const recentMessages = history.slice(-MAX_HISTORY);
    const olderMessages = history.slice(0, -MAX_HISTORY);

    if (olderMessages.length > 0) {
      const summary = this.compressHistory(olderMessages);
      return [
        { role: 'assistant', content: `[Earlier conversation summary: ${summary}]` },
        ...recentMessages,
      ];
    }

    return recentMessages;
  }

  private compressHistory(messages: ConversationMessage[]): string {
    const topics = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.substring(0, 50))
      .join(', ');
    return `User previously asked about: ${topics}`;
  }

  private estimateTokens(
    systemPrompt: string,
    history: ConversationMessage[],
    currentMessage: string
  ): number {
    const totalText =
      systemPrompt + history.map((m) => m.content).join(' ') + currentMessage;
    return Math.ceil(totalText.length / 4);
  }
}
