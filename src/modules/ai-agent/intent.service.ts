import type { LlmClient } from './services/llm-client.service.js';

export const INTENTS = {
  GREETING: 'greeting',
  PRICING: 'pricing',
  FEATURE_QUESTION: 'feature_question',
  TECHNICAL_SUPPORT: 'technical_support',
  ONBOARDING: 'onboarding',
  DEMO_REQUEST: 'demo_request',
  COMPLAINT: 'complaint',
  FAREWELL: 'farewell',
  HUMAN_REQUEST: 'human_request',
  MEDIA_REQUEST: 'media_request',
  OUT_OF_SCOPE: 'out_of_scope',
  GENERAL: 'general',
} as const;

export type Intent = (typeof INTENTS)[keyof typeof INTENTS];

export const INTENT_TO_SKILLS: Record<string, string[]> = {
  pricing: ['Pricing Inquiry', 'Pricing and plans', 'Send media'],
  feature_question: ['Feature Explanation', 'Product overview'],
  technical_support: ['Technical Support', 'WhatsApp connect'],
  onboarding: ['Onboarding Assistance', 'WhatsApp connect'],
  demo_request: ['Demo Request', 'Book demo'],
  greeting: [],
  farewell: [],
  complaint: ['Technical Support'],
  human_request: [],
  media_request: ['Send media'],
  out_of_scope: [],
  general: [],
};

/** Explicit ask for a human — not "AI agent" product talk or media sends. */
export function looksLikeHumanRequest(message: string): boolean {
  return /\b(talk\s+to\s+(a\s+)?human|real\s+person|human\s+agent|live\s+agent|customer\s+care|representative|agent\s+se\s+baat|insan\s+se\s+baat|humano?\s+se\s+baat)\b/i.test(
    message
  );
}

/** User wants a file/image from Media Gallery. */
export function looksLikeMediaRequest(message: string): boolean {
  return /\b(image|photo|pdf|brochure|catalog|catalogue|menu|price\s*list|document|flyer|file|download|pic|picture|intro\s*image|bhejo|bhej\s*do|dedo|de\s*do|dikhao?|send\s+(me\s+)?(the\s+)?|share\s+(me\s+)?(the\s+)?)\b/i.test(
    message
  );
}

/** Correct common LLM mislabels (e.g. media ask → human_request). */
export function refineIntent(intent: Intent, message: string): Intent {
  if (looksLikeHumanRequest(message)) return INTENTS.HUMAN_REQUEST;
  if (looksLikeMediaRequest(message)) return INTENTS.MEDIA_REQUEST;
  // LLM often labels product/feature Qs as media_request — only keep when text clearly asks for a file.
  if (intent === INTENTS.MEDIA_REQUEST) return INTENTS.GENERAL;
  if (intent === INTENTS.HUMAN_REQUEST) return INTENTS.GENERAL;
  return intent;
}

export const INTENT_TO_KB_TAGS: Record<string, string[]> = {
  pricing: ['pricing', 'plans', 'billing'],
  feature_question: ['features', 'how-to'],
  technical_support: ['troubleshooting', 'errors', 'support'],
  onboarding: ['getting-started', 'setup'],
  demo_request: ['demo', 'sales'],
  general: [],
};

export async function classifyIntent(
  llm: LlmClient,
  message: string,
  conversationContext = ''
): Promise<{
  intent: Intent;
  confidence: number;
  tokensUsed: number;
}> {
  const systemPrompt = `You are an intent classifier. 
Classify the user message into exactly ONE of these intents:
${Object.values(INTENTS).join(', ')}

Rules:
- greeting: Hi, Hello, Hey, Namaste, first message
- pricing: price, cost, plan, subscription, kitna lagega, fees
- feature_question: how does X work, what is X feature
- technical_support: not working, error, problem, issue, bug
- onboarding: new user, setup, getting started, kahan se start
- demo_request: demo, show me a product walkthrough, presentation, call schedule
- complaint: frustrated, angry, not happy, worst
- farewell: bye, thanks, goodbye, done
- media_request: send/share image, photo, PDF, brochure, catalog, menu, price list, document, file bhejo
- human_request: ONLY explicit ask for a human/real person/live agent (talk to human, agent se baat). NEVER for send image/PDF/file requests.
- out_of_scope: completely unrelated to the business
- general: everything else

Respond with ONLY a JSON object:
{"intent": "pricing", "confidence": 0.95}`;

  const result = await llm.complete(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: conversationContext
          ? `Context: ${conversationContext}\nMessage: ${message}`
          : message,
      },
    ],
    { maxTokens: 50, temperature: 0, jsonMode: true }
  );

  const tokensUsed = result.usage.totalTokens;

  try {
    const parsed = JSON.parse(result.content) as { intent?: string; confidence?: number };
    const raw = Object.values(INTENTS).includes(parsed.intent as Intent)
      ? (parsed.intent as Intent)
      : INTENTS.GENERAL;
    return {
      intent: refineIntent(raw, message),
      confidence: parsed.confidence || 0.8,
      tokensUsed,
    };
  } catch {
    return { intent: refineIntent(INTENTS.GENERAL, message), confidence: 0.5, tokensUsed };
  }
}
