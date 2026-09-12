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

export const selectNumberBodySchema = z.object({
  number: z.string().min(4),
  displayNumber: z.string().optional(),
  city: z.string().optional(),
  countryIso: z.string().optional(),
  priceInrPaise: z.number().int().positive(),
});

export const payVerifyBodySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
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
});
