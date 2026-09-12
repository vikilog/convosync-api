import { z } from 'zod';

export const conversationIdParamsSchema = z.object({
  id: z.string(),
});

export const conversationMessageIdParamsSchema = z.object({
  messageId: z.string(),
});

export const conversationListQuerySchema = z.object({
  status: z.string().optional(),
  assignedTo: z.string().optional(),
  channel: z.string().optional(),
});

export const conversationMessagesQuerySchema = z.object({
  limit: z.string().optional(),
  before: z.string().optional(),
});

export const conversationAttachmentQuerySchema = z.object({
  index: z.string().optional(),
});

export const conversationOpenBodySchema = z.object({
  contactId: z.string().optional(),
  phoneNumberId: z.string().optional(),
});

export const conversationEmailSendBodySchema = z.object({
  contactId: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  templateId: z.string().optional(),
});

/** Empty/non-string content stays a handler 400 — do not reject here. */
export const conversationSendMessageBodySchema = z.object({
  content: z.unknown().optional(),
});

export const conversationSendTemplateBodySchema = z.object({
  templateId: z.string().optional(),
  variables: z.unknown().optional(),
});

export const conversationUpdateBodySchema = z.record(z.unknown()).default({});
