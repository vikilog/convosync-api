import type { AiContextService } from '../ai-knowledge/services/ai-context.service.js';
import { AiChatService } from './services/ai-chat.service.js';

export type AiChatContainer = {
  aiChatService: AiChatService;
};

let container: AiChatContainer | null = null;

export function createAiChatContainer(aiContextService: AiContextService): AiChatContainer {
  const aiChatService = new AiChatService(aiContextService);
  return { aiChatService };
}

export function initAiChatModule(aiContextService: AiContextService): AiChatContainer {
  if (!container) {
    container = createAiChatContainer(aiContextService);
  }
  return container;
}
