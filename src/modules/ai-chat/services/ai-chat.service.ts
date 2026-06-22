import type { AiContextService } from '../../ai-knowledge/services/ai-context.service.js';
import { OpenAiProvider, OpenAiProviderError } from '../providers/openai.provider.js';
import type { OpenAiMessage } from '../providers/openai.provider.js';
import type { AiChatInput, AiChatResult } from '../types/ai-chat.types.js';
import {
  buildContextQuery,
  normalizeChatHistory,
} from '../utils/conversation-context.js';
import { parseChatModelOutput } from '../utils/parse-chat-response.js';
import { buildChatSystemPrompt } from '../utils/system-prompt-builder.js';
import { recordWorkspaceTokenUsage } from '../../../services/workspaceTokenUsage.js';

export class AiChatError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'AiChatError';
  }
}

export class AiChatService {
  constructor(
    private readonly contextService: AiContextService,
    private readonly openai: OpenAiProvider = new OpenAiProvider()
  ) {}

  /**
   * Handles a single customer message: loads relevant salon knowledge,
   * builds a system prompt, calls OpenAI, and returns reply + intent.
   */
  async chat(workspaceId: string, input: AiChatInput): Promise<AiChatResult> {
    const message = input.message.trim();
    if (!message) {
      throw new AiChatError('Message cannot be empty', 'INVALID_MESSAGE', 400);
    }

    const history = normalizeChatHistory(input.history);
    const contextQuery = buildContextQuery(message, history);

    const contextResult = await this.contextService.getContextForQuery(
      contextQuery,
      input.venueId,
      workspaceId
    );

    const systemPrompt = buildChatSystemPrompt(input, contextResult, history.length > 0);

    const openAiMessages: OpenAiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    try {
      const completion = await this.openai.createChatCompletion(openAiMessages);

      const parsed = parseChatModelOutput(
        completion.content,
        'Sorry, I could not process that. Please try again or contact the salon directly.'
      );

      const inputTokens = completion.usage.promptTokens || 0;
      const outputTokens = completion.usage.completionTokens || 0;

      await recordWorkspaceTokenUsage({
        workspaceId,
        agentId: input.channel === 'whatsapp' ? 'ai_copilot' : 'ai_knowledge',
        inputTokens,
        outputTokens,
        intentDetected: parsed.intent,
        fromCache: false,
      });

      return {
        ...parsed,
        tokensUsed: completion.usage.totalTokens || inputTokens + outputTokens || undefined,
        inputTokens: inputTokens || undefined,
        outputTokens: outputTokens || undefined,
      };
    } catch (err) {
      if (err instanceof OpenAiProviderError) {
        throw new AiChatError(err.message, err.code, err.statusCode);
      }
      throw err;
    }
  }
}
