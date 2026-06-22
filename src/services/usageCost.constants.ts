/** Meta WhatsApp conversation rates for India (INR). Used for cost estimates on Usage & Cost. */
export const WA_CONVERSATION_RATES_INR = {
  marketing: 0.7846,
  utility: 0.165,
  authentication: 0.145,
  service: 0,
} as const;

export const WA_SERVICE_FREE_CONVERSATIONS = 1000;
export const WA_SERVICE_OVERAGE_RATE_INR = 0.12;

/** Estimated OpenAI GPT-4o mini rates shown on Usage & Cost (INR per 1K tokens). */
export const AI_INPUT_RATE_INR_PER_1K = 0.0025;
export const AI_OUTPUT_RATE_INR_PER_1K = 0.01;

/** Platform email overage (INR per 1K sends) — aligned to billing add-on catalog. */
export const EMAIL_RATE_INR_PER_1K = 8.3;

export type WhatsAppConversationCategory = keyof typeof WA_CONVERSATION_RATES_INR;

export const WHATSAPP_CATEGORY_META: Record<
  WhatsAppConversationCategory,
  { label: string; dot: string; badge: string; chartColor: string }
> = {
  marketing: {
    label: 'Marketing',
    dot: 'bg-orange-500',
    badge: 'bg-orange-50 text-orange-700 ring-orange-100',
    chartColor: '#F97316',
  },
  utility: {
    label: 'Utility',
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 text-blue-700 ring-blue-100',
    chartColor: '#3B82F6',
  },
  authentication: {
    label: 'Authentication',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    chartColor: '#10B981',
  },
  service: {
    label: 'Service',
    dot: 'bg-slate-400',
    badge: 'bg-slate-100 text-slate-600 ring-slate-200',
    chartColor: '#94A3B8',
  },
};
