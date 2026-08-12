/** Workspace country → Razorpay checkout currency (India INR, everyone else USD). */

export type BillingCurrency = 'INR' | 'USD';

const INDIA_ALIASES = new Set(['IN', 'IND', 'INDIA']);

/** Normalize stored country to ISO-3166 alpha-2 when possible. */
export function normalizeCountryCode(country: string | null | undefined): string {
  const raw = (country ?? '').trim();
  if (!raw) return 'IN';
  const upper = raw.toUpperCase();
  if (INDIA_ALIASES.has(upper)) return 'IN';
  // Already ISO2
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  // ISO3 → common cases we care about for billing split
  if (upper === 'USA' || upper === 'UNITED STATES' || upper === 'UNITED STATES OF AMERICA') {
    return 'US';
  }
  // Unknown long names: keep uppercase trimmed (not India → USD path via countryToCurrency)
  return upper.slice(0, 2);
}

export function isIndiaCountry(country: string | null | undefined): boolean {
  const raw = (country ?? '').trim().toUpperCase();
  if (!raw) return true; // schema default IN
  return INDIA_ALIASES.has(raw) || normalizeCountryCode(country) === 'IN';
}

export function countryToCurrency(country: string | null | undefined): BillingCurrency {
  return isIndiaCountry(country) ? 'INR' : 'USD';
}

/** Major → minor (paise or cents). */
export function toMinorUnits(major: number): number {
  return Math.round(major * 100);
}

export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

export type PlanPriceFields = {
  priceMonthlyPaise: number | null;
  priceAnnualPaise: number | null;
  priceMonthlyCents?: number | null;
  priceAnnualCents?: number | null;
};

export function planAmountMinor(
  plan: PlanPriceFields,
  billingCycle: 'monthly' | 'annual',
  currency: BillingCurrency
): number | null {
  if (currency === 'USD') {
    const cents =
      billingCycle === 'annual' ? plan.priceAnnualCents ?? null : plan.priceMonthlyCents ?? null;
    return cents != null && cents > 0 ? cents : null;
  }
  const paise =
    billingCycle === 'annual' ? plan.priceAnnualPaise ?? null : plan.priceMonthlyPaise ?? null;
  return paise != null && paise > 0 ? paise : null;
}

/** Minimum Razorpay order amount in minor units. */
export function minCheckoutMinor(currency: BillingCurrency): number {
  return currency === 'USD' ? 50 : 100; // $0.50 / ₹1
}

/** Minimum wallet top-up charge in minor units (₹100 / $2). */
export function minWalletTopupMinor(currency: BillingCurrency): number {
  return currency === 'USD' ? 200 : 10_000;
}
