import { z } from 'zod';

export const createRequestSchema = z.object({
  contactId: z.string().optional(),
  contactName: z.string().min(1),
  contactPhone: z.string().min(5),
  amountPaise: z.number().int().positive(),
  description: z.string().min(1).max(500),
  sendMode: z.enum(['plain', 'template']).optional(),
  templateId: z.string().optional(),
  templateVariables: z.array(z.string()).optional(),
});
