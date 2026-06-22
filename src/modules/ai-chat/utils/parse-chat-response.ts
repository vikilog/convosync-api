import { z } from 'zod';
import { AI_CHAT_INTENTS, type AiChatIntent, type AiChatResult } from '../types/ai-chat.types.js';

const chatJsonSchema = z.object({
  response: z.string().min(1),
  intent: z.string(),
  confidence: z.number().min(0).max(1),
});

export function parseChatModelOutput(raw: string, fallbackMessage: string): AiChatResult {
  const trimmed = raw.trim();
  const jsonText = extractJsonObject(trimmed);

  try {
    const parsed = chatJsonSchema.parse(JSON.parse(jsonText));
    return {
      response: parsed.response.trim(),
      intent: normalizeIntent(parsed.intent),
      confidence: roundConfidence(parsed.confidence),
    };
  } catch {
    return {
      response: trimmed || fallbackMessage,
      intent: 'unknown',
      confidence: 0.3,
    };
  }
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  return text;
}

function normalizeIntent(value: string): AiChatIntent {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  if ((AI_CHAT_INTENTS as readonly string[]).includes(normalized)) {
    return normalized as AiChatIntent;
  }
  return 'unknown';
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}
