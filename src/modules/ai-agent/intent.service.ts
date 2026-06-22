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
  OUT_OF_SCOPE: 'out_of_scope',
  GENERAL: 'general',
} as const;

export type Intent = (typeof INTENTS)[keyof typeof INTENTS];

export const INTENT_TO_SKILLS: Record<string, string[]> = {
  pricing: ['Pricing Inquiry'],
  feature_question: ['Feature Explanation'],
  technical_support: ['Technical Support'],
  onboarding: ['Onboarding Assistance'],
  demo_request: ['Demo Request'],
  greeting: [],
  farewell: [],
  complaint: ['Technical Support'],
  human_request: [],
  out_of_scope: [],
  general: [],
};

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
- demo_request: demo, show me, presentation, call schedule
- complaint: frustrated, angry, not happy, worst
- farewell: bye, thanks, goodbye, done
- human_request: talk to human, real person, agent chahiye
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
    const intent = Object.values(INTENTS).includes(parsed.intent as Intent)
      ? (parsed.intent as Intent)
      : INTENTS.GENERAL;
    return {
      intent,
      confidence: parsed.confidence || 0.8,
      tokensUsed,
    };
  } catch {
    return { intent: INTENTS.GENERAL, confidence: 0.5, tokensUsed };
  }
}
