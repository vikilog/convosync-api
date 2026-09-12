import { z } from 'zod';

export const whatsappConnectBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
  wabaId: z.string().optional(),
  phoneNumberId: z.string().optional(),
  phoneNumber: z.string().optional(),
  displayName: z.string().optional(),
  businessId: z.string().optional(),
  connectionMode: z.enum(['business_api', 'app_coexistence']).optional(),
});

export const whatsappPhoneParamsSchema = z.object({
  phoneNumberId: z.string(),
});

export const whatsappBusinessProfileBodySchema = z
  .object({
    about: z.string().optional(),
    address: z.string().optional(),
    description: z.string().optional(),
    email: z.string().optional(),
    websites: z.array(z.string()).optional(),
    vertical: z.string().optional(),
  })
  .default({});

export const whatsappPaymentQuerySchema = z.object({
  phoneNumberId: z.string().optional(),
});

export const whatsappPaymentModeBodySchema = z
  .object({
    paymentMode: z.string().optional(),
    phoneNumberId: z.string().optional(),
    businessId: z.string().optional(),
  })
  .default({});

export const whatsappPaymentRefreshBodySchema = z
  .object({
    phoneNumberId: z.string().optional(),
    businessId: z.string().optional(),
  })
  .default({});

export const whatsappPaymentAckBodySchema = z
  .object({
    phoneNumberId: z.string().optional(),
  })
  .default({});

export const whatsappDisconnectQuerySchema = z.object({
  phoneNumberId: z.string().optional(),
});

export const whatsappDisconnectBodySchema = z
  .object({
    phoneNumberId: z.string().optional(),
  })
  .default({});
