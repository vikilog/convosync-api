import {
  ccToDebitPaise,
  INSTAGRAM_MESSAGE_RATE_INR,
  JOURNEY_TRIGGER_RATE_INR,
  WALLET_CC_RATES,
  WA_CONVERSATION_RATES_INR,
  applyAiUsageMarkup,
} from './usageCost.constants.js';

/** Monthly platform subscription base fee (INR). Usage credits are separate. */
export const PLATFORM_MONTHLY_FEE_INR = 1999;
export const PLATFORM_MONTHLY_FEE_PAISE = PLATFORM_MONTHLY_FEE_INR * 100;

/** Default low-balance alert threshold (500 CC). */
export const DEFAULT_LOW_BALANCE_THRESHOLD_PAISE = 50_000;

/** Default auto-recharge amount (1000 CC). */
export const DEFAULT_AUTO_RECHARGE_AMOUNT_PAISE = 100_000;

export const AUTO_RECHARGE_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_AUTO_RECHARGE_FAILS = 3;

/** Minimum wallet top-up (₹100). */
export const MIN_WALLET_TOPUP_PAISE = 10_000;

/** Suggested top-up amounts in INR for the recharge UI. */
export const WALLET_TOPUP_PRESETS_INR = [500, 1000, 2000, 5000, 10000] as const;

export type WalletDebitCategory =
  | 'whatsapp_marketing'
  | 'whatsapp_utility'
  | 'whatsapp_authentication'
  | 'whatsapp_service'
  | 'ai_tokens'
  | 'email'
  | 'instagram'
  | 'journey_trigger'
  | 'adjustment';

export type WalletCreditCategory = 'wallet_topup' | 'refund' | 'adjustment';

function inrToPaise(amountInr: number): number {
  return ccToDebitPaise(amountInr);
}

export function whatsAppCategoryDebitPaise(
  category: string | null | undefined
): number {
  const normalized = (category ?? 'marketing').toLowerCase();
  if (normalized === 'utility') return inrToPaise(WA_CONVERSATION_RATES_INR.utility);
  if (normalized === 'authentication' || normalized === 'auth') {
    return inrToPaise(WA_CONVERSATION_RATES_INR.authentication);
  }
  if (normalized === 'service') return inrToPaise(WA_CONVERSATION_RATES_INR.service);
  return inrToPaise(WA_CONVERSATION_RATES_INR.marketing);
}

export function instagramMessageDebitPaise(): number {
  return inrToPaise(INSTAGRAM_MESSAGE_RATE_INR);
}

export function emailSendDebitPaise(sendCount = 1): number {
  const count = Math.max(1, Math.round(sendCount));
  return ccToDebitPaise(WALLET_CC_RATES.emailSend * count);
}

export function journeyTriggerDebitPaise(): number {
  return inrToPaise(JOURNEY_TRIGGER_RATE_INR);
}

export function aiUsageDebitPaise(costInr: number): number {
  const billedInr = applyAiUsageMarkup(costInr);
  if (billedInr <= 0) return 0;
  return inrToPaise(billedInr);
}

export function walletDebitCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    wallet_topup: 'ConvoCoins recharge',
    whatsapp_marketing: 'WhatsApp · Marketing',
    whatsapp_utility: 'WhatsApp · Utility',
    whatsapp_authentication: 'WhatsApp · Authentication',
    whatsapp_service: 'WhatsApp · Service',
    ai_tokens: 'AI tokens',
    email: 'Email send',
    instagram: 'Instagram message',
    journey_trigger: 'Journey trigger',
    refund: 'Refund',
    adjustment: 'Adjustment',
  };
  return labels[category] ?? category;
}
