export type SendMessageInput = {
  workspaceId: string;
  contactId: string;
  phone: string;
  templateName?: string;
  templateId?: string;
  language?: string;
  variables?: string[];
  text?: string;
  metadata?: Record<string, unknown>;
};

export type SendMessageResult = {
  messageId: string;
  conversationId: string;
  waMessageId?: string;
  renderedBody: string;
};

export interface MessagingProvider {
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
