import { ZodError } from 'zod';

export type RazorpayErrorDetails = {
  message: string;
  statusCode?: number;
  code?: string;
  description?: string;
  field?: string;
  reason?: string;
  source?: string;
  step?: string;
  metadata?: unknown;
  /** Nested `error` object from the SDK/HTTP body, when present. */
  rawError?: unknown;
};

type NestedRazorpayError = {
  description?: string;
  code?: string;
  field?: string;
  reason?: string;
  source?: string;
  step?: string;
  metadata?: unknown;
};

function nestedFrom(err: unknown): NestedRazorpayError | null {
  if (typeof err !== 'object' || err === null) return null;
  const nested = (err as { error?: unknown }).error;
  if (typeof nested !== 'object' || nested === null) return null;
  return nested as NestedRazorpayError;
}

/** Pull description/field/source/etc. — Razorpay often omits field on account-level rejects. */
export function extractRazorpayErrorDetails(err: unknown): RazorpayErrorDetails {
  if (err instanceof ZodError) {
    return { message: err.errors.map((e) => e.message).join('; ') };
  }

  if (typeof err === 'string' && err.trim()) {
    return { message: err };
  }

  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>;
    const statusCode = typeof o.statusCode === 'number' ? o.statusCode : undefined;
    const nested = nestedFrom(err);

    if (nested?.description) {
      const bits = [nested.description];
      if (nested.field) bits.push(`field=${nested.field}`);
      if (nested.reason) bits.push(`reason=${nested.reason}`);
      if (nested.source) bits.push(`source=${nested.source}`);
      if (nested.step) bits.push(`step=${nested.step}`);
      if (nested.code) bits.push(`(${nested.code})`);
      return {
        message: bits.join(' '),
        statusCode,
        code: nested.code,
        description: nested.description,
        field: nested.field,
        reason: nested.reason,
        source: nested.source,
        step: nested.step,
        metadata: nested.metadata,
        rawError: nested,
      };
    }

    if (typeof o.error === 'string' && o.error.trim()) {
      if (statusCode === 401) {
        return { message: razorpay401Message(), statusCode, rawError: o.error };
      }
      return {
        message: `Razorpay: ${o.error}${statusCode != null ? ` (${statusCode})` : ''}`,
        statusCode,
        rawError: o.error,
      };
    }

    if (statusCode === 401) {
      return { message: razorpay401Message(), statusCode };
    }

    // Normalized Error that already carries `.razorpay` details
    const attached = o.razorpay;
    if (typeof attached === 'object' && attached !== null) {
      const d = attached as RazorpayErrorDetails;
      if (typeof d.message === 'string' && d.message.trim()) return d;
    }

    if (typeof o.message === 'string' && o.message.trim() && o.message !== '[object Object]') {
      return { message: o.message, statusCode, rawError: nested ?? undefined };
    }
  }

  if (err instanceof Error) return { message: err.message };

  return { message: 'Billing operation failed' };
}

/** Razorpay Node SDK often rejects with Error-like objects that still carry `.error`. */
export function normalizeRazorpayError(err: unknown): Error & { razorpay?: RazorpayErrorDetails } {
  const details = extractRazorpayErrorDetails(err);
  const out = new Error(details.message) as Error & { razorpay?: RazorpayErrorDetails };
  out.razorpay = details;
  return out;
}

function razorpay401Message(): string {
  return (
    'Razorpay returned 401 Unauthorized. If one-time payments work but subscriptions fail, enable ' +
    'Subscriptions in Razorpay Dashboard → Account & Settings → Products. ' +
    'Also confirm Key ID and Key Secret are from the same test/live key pair.'
  );
}

/** Razorpay often returns 401 when Subscriptions product is disabled (orders API still works). */
export function isRazorpayUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const o = err as Record<string, unknown>;
  return o.statusCode === 401;
}

/** Razorpay returns misleading "URL not found" when a product/API is disabled on the account. */
export function isRazorpayFeatureNotEnabledError(err: unknown): boolean {
  const message = normalizeRazorpayError(err).message.toLowerCase();
  return message.includes('url was not found') || message.includes('not found on the server');
}

export function razorpayRecurringNotEnabledMessage(): string {
  return (
    'Razorpay Recurring Payments API is not enabled on this merchant account. ' +
    'Open Razorpay Dashboard → Account & Settings → Products and request Recurring Payments / ' +
    'Tokenisation activation, or contact Razorpay support. One-time checkout can work while this API stays disabled.'
  );
}

export function formatBillingError(err: unknown): string {
  if (isRazorpayFeatureNotEnabledError(err)) {
    return razorpayRecurringNotEnabledMessage();
  }
  return normalizeRazorpayError(err).message;
}
