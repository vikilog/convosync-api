import type { AiChatHistoryMessage } from '../types/ai-chat.types.js';

const MAX_HISTORY_TURNS = 20;
const CONTEXT_QUERY_TURNS = 6;

/** Trim and cap history for OpenAI (drops empty content). */
export function normalizeChatHistory(
  history: AiChatHistoryMessage[] | undefined
): AiChatHistoryMessage[] {
  if (!history?.length) return [];

  return history
    .filter((m) => m.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.role,
      content: m.content.trim(),
    }));
}

/**
 * Combine recent conversation text so follow-ups like "2 pm" still route to
 * booking/services context when the prior turn mentioned an appointment.
 */
export function buildContextQuery(
  message: string,
  history?: AiChatHistoryMessage[]
): string {
  const trimmed = message.trim();
  const recent = normalizeChatHistory(history).slice(-CONTEXT_QUERY_TURNS);

  if (recent.length === 0) return trimmed;

  const prior = recent.map((m) => m.content).join(' ');
  return `${prior} ${trimmed}`.trim();
}
