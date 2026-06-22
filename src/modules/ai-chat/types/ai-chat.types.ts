/** Detected customer intent for routing (tool calling added later). */
export type AiChatIntent =
  | 'general_question'
  | 'service_inquiry'
  | 'booking'
  | 'cancel_booking'
  | 'reschedule_booking'
  | 'membership_question'
  | 'voucher_question'
  | 'staff_question'
  | 'unknown';

export const AI_CHAT_INTENTS = [
  'general_question',
  'service_inquiry',
  'booking',
  'cancel_booking',
  'reschedule_booking',
  'membership_question',
  'voucher_question',
  'staff_question',
  'unknown',
] as const satisfies readonly AiChatIntent[];

export type AiChatChannel = 'whatsapp' | 'instagram' | 'messenger' | 'web' | 'sms' | string;

export type AiChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiChatInput = {
  venueId: string;
  message: string;
  customerId: string;
  channel: AiChatChannel;
  /** Prior turns in this conversation (oldest first). */
  history?: AiChatHistoryMessage[];
};

export type AiChatResult = {
  response: string;
  intent: AiChatIntent;
  confidence: number;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type OpenAiChatJson = {
  response: string;
  intent: string;
  confidence: number;
};
