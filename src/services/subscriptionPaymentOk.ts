/**
 * Whether a Razorpay subscription checkout payment is enough to activate the plan.
 * Future-start subscriptions charge a refundable auth token ($0.50 / ₹1) then refund it —
 * payment ends as `refunded` while the subscription is `authenticated` / `active`.
 */
export function subscriptionCheckoutPaymentOk(params: {
  paymentStatus: string;
  subscriptionStatus: string;
}): boolean {
  const pay = params.paymentStatus.toLowerCase();
  const sub = params.subscriptionStatus.toLowerCase();
  if (pay === 'captured' || pay === 'authorized') return true;
  if (pay === 'refunded' && (sub === 'authenticated' || sub === 'active')) return true;
  return false;
}

/** Checkout description is `${planName} (${billingCycle})` — used when payment.subscription_id is missing. */
export function matchSubscriptionIdByCheckoutDescription(
  description: string,
  offers: Array<{
    planName: string;
    billingCycle: string;
    razorpaySubscriptionId: string;
  }>
): string | null {
  const needle = description.trim().toLowerCase();
  if (!needle) return null;
  const matches = offers.filter((offer) => {
    const expected = `${offer.planName} (${offer.billingCycle})`.trim().toLowerCase();
    return needle === expected;
  });
  return matches[0]?.razorpaySubscriptionId ?? null;
}
