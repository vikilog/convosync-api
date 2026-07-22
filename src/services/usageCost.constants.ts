/** Canonical wallet rates (1 CC = ₹1). Keep in sync with frontend walletPricing.ts */
export const WALLET_CC_RATES = {
  whatsappMarketing: 1,
  whatsappUtility: 0.3,
  whatsappAuthentication: 0.3,
  instagramMessage: 0.01,
  emailSend: 1,
  journeyTrigger: 0.1,
  aiEstimatedReply: 5,
  inbox: 0,
} as const;

/** ConvoCoins per WhatsApp conversation (1 CC = ₹1). */
export const WA_CONVERSATION_RATES_INR = {
  marketing: WALLET_CC_RATES.whatsappMarketing,
  utility: WALLET_CC_RATES.whatsappUtility,
  authentication: WALLET_CC_RATES.whatsappAuthentication,
  service: WALLET_CC_RATES.inbox,
} as const;

export const WA_SERVICE_FREE_CONVERSATIONS = 1000;
export const WA_SERVICE_OVERAGE_RATE_INR = 0.12;

/** Estimated OpenAI GPT-4o mini rates shown on Usage & Cost (INR per 1K tokens). */
export const AI_INPUT_RATE_INR_PER_1K = 0.0025;
export const AI_OUTPUT_RATE_INR_PER_1K = 0.01;

/** Platform markup on GPT usage billed to wallet (35%). */
export const AI_USAGE_MARKUP_MULTIPLIER = 1.35;

/** Typical AI reply estimate for calculator UI. */
export const AI_ESTIMATED_CC_PER_REPLY = WALLET_CC_RATES.aiEstimatedReply;

/** Email — 1 CC per send. */
export const EMAIL_RATE_INR_PER_SEND = WALLET_CC_RATES.emailSend;
export const EMAIL_RATE_INR_PER_1K = EMAIL_RATE_INR_PER_SEND * 1000;

/** How many of this batch are billable after plan included email credit (1 CC = 1 email). */
export function emailBillableSends(params: {
  sentBefore: number;
  sendCount: number;
  emailsIncluded: number;
}): number {
  const sendCount = Math.max(0, Math.round(params.sendCount));
  const sentBefore = Math.max(0, Math.round(params.sentBefore));
  const included = params.emailsIncluded;
  if (included <= 0) return sendCount;
  if (included >= Number.MAX_SAFE_INTEGER) return 0;
  const freeLeft = Math.max(0, included - sentBefore);
  return Math.max(0, sendCount - freeLeft);
}

/**
 * Wallet debit for this charge after monthly included credit (same unit as cost — tokens/CC).
 * billedAfter - billedBefore so running wallet spend matches month Usage "Final billed".
 */
export function incrementalIncludedBillable(params: {
  mtdGrossBefore: number;
  thisCharge: number;
  includedCredit: number;
}): number {
  const thisCharge = Math.max(0, params.thisCharge);
  const mtdBefore = Math.max(0, params.mtdGrossBefore);
  const included = params.includedCredit;
  if (thisCharge <= 0) return 0;
  if (included <= 0) return Math.round(thisCharge * 100) / 100;
  if (included >= Number.MAX_SAFE_INTEGER) return 0;
  const billedBefore = Math.max(0, mtdBefore - included);
  const billedAfter = Math.max(0, mtdBefore + thisCharge - included);
  return Math.round((billedAfter - billedBefore) * 100) / 100;
}

/** Instagram DM — 0.01 CC per message. */
export const INSTAGRAM_MESSAGE_RATE_INR = WALLET_CC_RATES.instagramMessage;

/** Journey entry — 0.1 CC per trigger. */
export const JOURNEY_TRIGGER_RATE_INR = WALLET_CC_RATES.journeyTrigger;

export function ccToDebitPaise(cc: number): number {
  if (cc <= 0) return 0;
  return Math.max(1, Math.ceil(cc * 100));
}

export function applyAiUsageMarkup(costInr: number): number {
  if (costInr <= 0) return 0;
  return Math.round(costInr * AI_USAGE_MARKUP_MULTIPLIER * 100) / 100;
}

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
