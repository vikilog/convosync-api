import type { Contact } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { getIo } from '../../../socket.js';
import { parseInstagramScopedUserId } from '../../../lib/channelContact.js';
import { findOrReopenConversationForInbound } from '../../../services/conversationThread.service.js';
import {
  formatInstagramSendError,
  sendInstagramMessage,
  sendInstagramTypingOn,
} from '../../../services/instagram.js';
import {
  previewForMessage,
  sendInstagramMediaMessage,
  sendInstagramTemplateMessage,
  type InstagramAttachmentKind,
  type InstagramTemplateElement,
} from '../../../services/instagramMedia.js';
import { getWorkspaceInstagramCredentials } from '../../../services/instagramCredentials.js';
import { sendPrivateReplyToComment } from '../../../services/instagramListening.service.js';
import { sleep, typingDelayMs } from '../../journey/services/typing-indicator.service.js';

export type IgSendInput = {
  workspaceId: string;
  contactId: string;
  text: string;
  quickReplies?: Array<{ title: string; payload?: string }>;
  metadata?: Record<string, unknown>;
  simulateTyping?: boolean;
};

export type IgSendMediaInput = {
  workspaceId: string;
  contactId: string;
  kind: InstagramAttachmentKind;
  mediaUrl: string;
  caption?: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type IgSendTemplateInput = {
  workspaceId: string;
  contactId: string;
  elements: InstagramTemplateElement[];
  /** Inbox preview text — generic template has no plain-text body of its own. */
  previewText: string;
  metadata?: Record<string, unknown>;
};

export type IgSendResult = {
  messageId: string;
  conversationId: string;
};

export class InstagramMessagingProvider {
  async send(input: IgSendInput): Promise<IgSendResult> {
    const creds = await getWorkspaceInstagramCredentials(input.workspaceId);
    const contact = await this.requireContact(input);
    const recipientId = this.requireIgsid(contact);

    if (input.simulateTyping) {
      try {
        await sendInstagramTypingOn(creds.pageId, creds.pageAccessToken, recipientId);
      } catch (err) {
        console.warn('[IgJourney] typing_on failed', err);
      }
      await sleep(typingDelayMs(input.text));
    }

    let messageId: string;
    try {
      const result = await sendInstagramMessage(
        creds.pageId,
        creds.pageAccessToken,
        recipientId,
        input.text,
        {
          instagramUserId: creds.instagramUserId,
          quickReplies: input.quickReplies,
        }
      );
      messageId = result.messageId;
    } catch (err) {
      throw new Error(formatInstagramSendError(err));
    }

    return this.recordOutbound(input, contact, messageId, creds.pageId);
  }

  /**
   * Meta comment private reply — opens the DM window from a comment (recipient.comment_id)
   * instead of a normal PSID-addressed send. Only valid for the first eligible reply to a
   * given comment; callers must gate on that themselves (see journey engine).
   */
  async sendPrivateReply(input: IgSendInput & { commentId: string }): Promise<IgSendResult> {
    const creds = await getWorkspaceInstagramCredentials(input.workspaceId);
    const contact = await this.requireContact(input);
    this.requireIgsid(contact);

    // Runtime safety net: Meta's private-reply endpoint only accepts { text }. If a caller
    // ever passes quick replies here (rich content isn't wired in today), drop them instead
    // of letting Meta reject the whole send — text-only always succeeds.
    if (input.quickReplies?.length) {
      console.warn('[IgJourney] private_reply ignores quickReplies (text-only Meta constraint)', {
        commentId: input.commentId,
      });
    }

    const result = await sendPrivateReplyToComment(
      input.workspaceId,
      input.commentId,
      input.text,
      creds.instagramUserId
    );

    return this.recordOutbound(input, contact, result.messageId, creds.pageId);
  }

  /** Image/PDF/audio/video content block — Meta needs one publicly fetchable HTTPS URL. */
  async sendMedia(input: IgSendMediaInput): Promise<IgSendResult> {
    const creds = await getWorkspaceInstagramCredentials(input.workspaceId);
    const contact = await this.requireContact(input);
    const recipientId = this.requireIgsid(contact);

    let messageId: string;
    try {
      const result = await sendInstagramMediaMessage(
        creds.pageId,
        creds.pageAccessToken,
        recipientId,
        input.kind,
        input.mediaUrl
      );
      messageId = result.messageId;
    } catch (err) {
      throw new Error(formatInstagramSendError(err));
    }

    const messageKind = input.kind === 'file' ? 'document' : input.kind;
    const preview = previewForMessage(messageKind, input.fileName || '', input.caption);
    const sent = await this.recordOutbound(
      { workspaceId: input.workspaceId, text: preview, metadata: input.metadata },
      contact,
      messageId,
      creds.pageId,
      { content: preview, type: messageKind }
    );

    // Caption rides as a follow-up text — IG media attachments have no caption field of their own.
    if (input.caption?.trim()) {
      try {
        await this.send({
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          text: input.caption,
        });
      } catch (err) {
        console.warn('[IgJourney] media caption send failed', err);
      }
    }

    return sent;
  }

  /** Card (1 element) / Gallery (2-10 elements) content block via Messenger generic template. */
  async sendTemplate(input: IgSendTemplateInput): Promise<IgSendResult> {
    const creds = await getWorkspaceInstagramCredentials(input.workspaceId);
    const contact = await this.requireContact(input);
    const recipientId = this.requireIgsid(contact);

    let messageId: string;
    try {
      const result = await sendInstagramTemplateMessage(
        creds.pageId,
        creds.pageAccessToken,
        recipientId,
        input.elements
      );
      messageId = result.messageId;
    } catch (err) {
      throw new Error(formatInstagramSendError(err));
    }

    const type = input.elements.length > 1 ? 'gallery' : 'card';
    return this.recordOutbound(
      { workspaceId: input.workspaceId, text: input.previewText, metadata: input.metadata },
      contact,
      messageId,
      creds.pageId,
      { content: input.previewText, type }
    );
  }

  private async requireContact(input: Pick<IgSendInput, 'contactId' | 'workspaceId'>) {
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, workspaceId: input.workspaceId },
    });
    if (!contact) throw new Error('Contact not found');
    return contact;
  }

  private requireIgsid(contact: Contact): string {
    const recipientId = parseInstagramScopedUserId(contact.phone);
    if (!recipientId) throw new Error('Contact is not an Instagram contact');
    return recipientId;
  }

  private async recordOutbound(
    input: Pick<IgSendInput, 'workspaceId' | 'text' | 'metadata'>,
    contact: Contact,
    messageId: string,
    pageId: string,
    overrides?: { content: string; type: string }
  ): Promise<IgSendResult> {
    const content = overrides?.content ?? input.text;
    const type = overrides?.type ?? 'text';

    const { conversation } = await findOrReopenConversationForInbound({
      workspaceId: input.workspaceId,
      contactId: contact.id,
      channel: 'instagram',
      channelAccountId: pageId,
    });

    const message = await prisma.message.create({
      data: {
        waMessageId: messageId,
        conversationId: conversation.id,
        sender: 'agent',
        senderName: 'Instagram Automation',
        content,
        type,
        metadata: (input.metadata ?? {}) as object,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: content,
        lastMessageAt: new Date(),
        channelAccountId: pageId,
      },
    });

    try {
      const socket = getIo();
      socket.to(input.workspaceId).emit('new_message', {
        conversationId: conversation.id,
        message,
      });
      socket.to(input.workspaceId).emit('conversation_updated', {
        conversationId: conversation.id,
      });
    } catch {
      // Socket optional outside the HTTP server (scripts / workers).
    }

    return { messageId, conversationId: conversation.id };
  }
}
