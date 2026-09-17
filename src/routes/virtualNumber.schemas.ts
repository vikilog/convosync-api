import { z } from 'zod';

export const callLogQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const placeCallBodySchema = z.object({ to: z.string().min(6) });

export const requestAccessBodySchema = z.object({
  label: z.string().trim().max(80).optional(),
  description: z.string().trim().max(300).optional(),
});

export const availableNumbersQuerySchema = z.object({
  pattern: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(9),
});

// Checkout only ever settles in INR or USD — the only two currencies this Razorpay
// account has ever actually charged (see billingCurrency.ts / billing.service.ts).
// An admin-configured GBP/SGD price is still allowed to exist (super-admin pricing
// table), it just can't be selected for purchase yet.
export const CHECKOUT_CURRENCY = z.enum(['INR', 'USD']);

export const selectNumberBodySchema = z.object({
  number: z.string().min(4),
  displayNumber: z.string().optional(),
  city: z.string().optional(),
  countryIso: z.string().optional(),
  priceMinor: z.number().int().positive(),
  currency: CHECKOUT_CURRENCY,
});

// The number's monthly rental is a real recurring Razorpay Subscription, not a
// one-time order — verification uses the subscription id + the payment that
// authenticated it (see verifyRazorpaySubscriptionSignature in crypto.utils.ts).
export const payVerifyBodySchema = z.object({
  razorpay_subscription_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
  /** Add-ons the workspace opted into on the checkout page — preference only for
   * now, see the fields' doc comments in schema.prisma. Omitted/false = not opted in. */
  transcriptionEnabled: z.boolean().optional(),
  recordingStorageEnabled: z.boolean().optional(),
});

export const numberSettingsBodySchema = z.object({
  label: z.string().trim().max(80).optional(),
  description: z.string().trim().max(300).optional(),
  missedCallAutoReplyEnabled: z.boolean().optional(),
  missedCallMessage: z.string().trim().max(1000).optional(),
  missedCallTemplateId: z.string().trim().max(64).nullable().optional(),
  userMissedCallAutoReplyEnabled: z.boolean().optional(),
  userMissedCallMessage: z.string().trim().max(1000).optional(),
  userMissedCallTemplateId: z.string().trim().max(64).nullable().optional(),
  /** Preference only for now — see the field's doc comment in schema.prisma. */
  transcriptionEnabled: z.boolean().optional(),
  recordingStorageEnabled: z.boolean().optional(),
});
