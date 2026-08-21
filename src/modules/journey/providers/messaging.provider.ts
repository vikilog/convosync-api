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
  /** Length-based typing delay before send (channel-supported when possible). */
  simulateTyping?: boolean;
  /** WA interactive reply buttons (max 3). */
  buttons?: Array<{ id: string; title: string }>;
  /**
   * WA `interactive.type: "cta_url"` message — a single link button, mutually exclusive with
   * `buttons`. Meta doesn't allow a URL type inside reply-button/quick-reply messages.
   */
  ctaUrl?: string;
  ctaButtonLabel?: string;
  /** WhatsApp Flow send — mutually exclusive with buttons/ctaUrl/templateName. */
  flow?: {
    metaFlowId: string;
    flowToken: string;
    ctaLabel: string;
    firstScreenId: string;
    headerText?: string;
  };
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
