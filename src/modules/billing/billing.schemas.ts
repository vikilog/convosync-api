import { z } from 'zod';

export const billingLimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const billingMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export const updateWalletSchema = z.object({
  lowBalanceThresholdPaise: z.number().int().min(1000).max(1_000_000).optional(),
  // AUTO_RECHARGE_DISABLED — re-enable later
  // autoRechargeEnabled: z.boolean().optional(),
  // autoRechargeAmountPaise: z.number().int().min(10_000).max(1_000_000).optional(),
});

export const createOrderSchema = z.object({
  amountPaise: z.number().int().positive().optional(),
  purpose: z.enum(['addon', 'custom_plan', 'plan_purchase', 'one_time', 'wallet_topup']).optional(),
  addonType: z
    .enum([
      'contacts',
      'team_members',
      'ai_agents',
      'channels',
      'ai_tokens',
      'campaigns',
      'emails',
    ])
    .optional(),
  quantity: z.number().int().positive().optional(),
  description: z.string().optional(),
  creditAmountPaise: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const verifyOrderSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

export const createSubscriptionSchema = z.object({
  planId: z.string(),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
  couponCode: z.string().trim().min(1).max(40).optional(),
});

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  amountPaise: z.number().int().positive(),
  planId: z.string().optional(),
});

export const verifySubscriptionSchema = z.object({
  razorpay_payment_id: z.string(),
  razorpay_subscription_id: z.string(),
  razorpay_signature: z.string(),
});

export const cancelSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().optional(),
});

export const refundSchema = z.object({
  paymentId: z.string(),
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export type BillingLimitQuery = z.infer<typeof billingLimitQuerySchema>;
export type BillingMonthQuery = z.infer<typeof billingMonthQuerySchema>;
export type UpdateWalletBody = z.infer<typeof updateWalletSchema>;
export type CreateOrderBody = z.infer<typeof createOrderSchema>;
export type VerifyOrderBody = z.infer<typeof verifyOrderSchema>;
export type CreateSubscriptionBody = z.infer<typeof createSubscriptionSchema>;
export type ValidateCouponBody = z.infer<typeof validateCouponSchema>;
export type VerifySubscriptionBody = z.infer<typeof verifySubscriptionSchema>;
export type CancelSubscriptionBody = z.infer<typeof cancelSubscriptionSchema>;
export type RefundBody = z.infer<typeof refundSchema>;
