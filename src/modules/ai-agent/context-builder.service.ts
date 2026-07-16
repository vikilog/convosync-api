import { FastifyInstance } from 'fastify';
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

    const relevantSkillTitles = INTENT_TO_SKILLS[params.intent] || [];
    const relevantSkills = agent.skills.filter((skill) =>
      relevantSkillTitles.some((title) =>
        skill.title.toLowerCase().includes(title.toLowerCase())
      )
    );

    const relevantTags = INTENT_TO_KB_TAGS[params.intent] || [];
    let relevantKB = agent.knowledgeItems;

    if (relevantTags.length > 0) {
      relevantKB = agent.knowledgeItems.filter((item) => {
        const metadata = item.metadata as { tags?: string[] } | null;
        const tags = metadata?.tags || [];
        return relevantTags.some(
          (tag) =>
            tags.includes(tag) ||
            item.title.toLowerCase().includes(tag) ||
            item.type === 'qna'
        );
      });
    }

    const { chunks: kbChunks } = await retrieveKnowledgeChunks({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      query: params.currentMessage,
      fallbackItems: relevantKB,
    });

    const systemPrompt = this.buildSystemPrompt({
      agent,
      intent: params.intent,
      stage: params.stage,
      relevantSkills,
      kbChunks,
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
  }): string {
    const { agent, intent, stage, relevantSkills, kbChunks } = params;

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

    let prompt = `You are ${agent.name}, an AI assistant.

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
        const content = chunk.content?.substring(0, 500) || '';
        prompt += `${chunk.title}:\n${content}\n\n`;
      });
    }

    prompt += `\nRULES:
- Keep responses concise (max 3-4 sentences)
- Never make up information not in knowledge base
- If unsure, say you'll connect them with a human agent
- Always end with a helpful follow-up question`;

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
