import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyRazorpayPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): boolean {
  const body = `${orderId}|${paymentId}`;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return safeCompare(expected, signature);
}

export function verifyRazorpaySubscriptionSignature(
  paymentId: string,
  subscriptionId: string,
  signature: string,
  secret: string
): boolean {
  const body = `${paymentId}|${subscriptionId}`;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return safeCompare(expected, signature);
}

export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeCompare(expected, signature);
}

function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
