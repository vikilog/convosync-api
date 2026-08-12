/** Admin intent: subscription is default; payment_link only when chosen. */
export type BillingOfferCheckoutKind = 'subscription' | 'payment_link';

/** Pure decision for self-check / callers. */
export function resolveOfferCheckoutKind(input: {
  checkoutKind: BillingOfferCheckoutKind;
  allowPaymentLinkFallback: boolean;
  subscriptionFailed: boolean;
  subscriptionErrorMessage?: string;
}): { kind: BillingOfferCheckoutKind; fallbackReason?: string } {
  if (input.checkoutKind === 'payment_link') return { kind: 'payment_link' };
  if (!input.subscriptionFailed) return { kind: 'subscription' };
  if (input.allowPaymentLinkFallback) {
    return {
      kind: 'payment_link',
      fallbackReason: input.subscriptionErrorMessage?.trim() || 'Subscription create failed',
    };
  }
  throw new Error(
    input.subscriptionErrorMessage?.trim() ||
      'Razorpay subscription create failed. Retry, or enable payment-link fallback.'
  );
}
