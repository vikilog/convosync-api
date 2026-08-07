/** Meta Business Manager — billing payment methods for a business portfolio. */
export function buildMetaPaymentSetupUrl(businessId?: string | null): string {
  const id = businessId?.trim();
  if (id && /^\d+$/.test(id)) {
    return `https://business.facebook.com/billing_hub/payment_methods?business_id=${id}`;
  }
  return 'https://business.facebook.com/billing_hub/payment_methods';
}

/**
 * True when the WABA has a Meta messaging-billing funding source.
 * Use WABA `primary_funding_id` (paid-service funding) — not Payments-in
 * `payment_configuration` (commerce / UPI / PG; that edge requires configuration_name).
 *
 * ponytail: field is BSP-gated; Tech Provider apps get Graph #10 — treat as unknown, not missing.
 */
export function parseHasOwnMetaPaymentMethod(input: {
  primaryFundingId?: unknown;
}): boolean {
  const funding = input.primaryFundingId;
  if (typeof funding === 'string' && funding.trim().length > 0) return true;
  if (typeof funding === 'number' && Number.isFinite(funding)) return true;
  return false;
}

export type BillingCheckStatus = 'confirmed' | 'missing' | 'unknown';

export function extractMetaErrorCode(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const code = (data as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

/**
 * Graph authorization / eligibility failures.
 * Code 10 includes “Business that owns this App is a Business Solution Partner…” for
 * `primary_funding_id` on Tech Provider apps.
 */
export function isBillingProbePermissionError(code: number | null): boolean {
  if (code == null) return false;
  if (code === 10 || code === 3) return true;
  // Generic “permission not granted / removed”
  if (code >= 200 && code <= 299) return true;
  return false;
}

/** Calm copy for TP / non-BSP apps — not a hard Self Pay blocker. */
export function billingCheckUnknownNote(): string {
  return 'Automatic billing check needs Solution Partner access. Open Meta to add a payment method, then continue.';
}

/** Human-readable Meta Graph error for payment-mode refresh failures. */
export function formatMetaBillingProbeError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const err = (data as { error?: { message?: unknown; code?: unknown; error_subcode?: unknown } })
    .error;
  if (!err || typeof err.message !== 'string' || !err.message.trim()) return fallback;
  const code = typeof err.code === 'number' ? ` (#${err.code})` : '';
  return `Meta could not check billing payment method${code}: ${err.message}`;
}
