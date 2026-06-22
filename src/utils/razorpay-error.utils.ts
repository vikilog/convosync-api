import { ZodError } from 'zod';

/** Razorpay Node SDK rejects with plain objects, not Error instances. */
export function normalizeRazorpayError(err: unknown): Error {
  if (err instanceof Error) return err;

  if (err instanceof ZodError) {
    return new Error(err.errors.map((e) => e.message).join('; '));
  }

  if (typeof err === 'string' && err.trim()) {
    return new Error(err);
  }

  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>;
    const nested = o.error;

    if (typeof nested === 'object' && nested !== null) {
      const description = (nested as { description?: string }).description;
      const code = (nested as { code?: string }).code;
      if (description) {
        return new Error(code ? `${description} (${code})` : description);
      }
    }

    if (typeof nested === 'string' && nested.trim()) {
      const status = o.statusCode != null ? ` (${o.statusCode})` : '';
      if (o.statusCode === 401) {
        return new Error(razorpay401Message());
      }
      return new Error(`Razorpay: ${nested}${status}`);
    }

    if (typeof o.message === 'string' && o.message.trim()) {
      return new Error(o.message);
    }

    if (o.statusCode === 401) {
      return new Error(razorpay401Message());
    }
  }

  return new Error('Billing operation failed');
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

export function formatBillingError(err: unknown): string {
  return normalizeRazorpayError(err).message;
}
