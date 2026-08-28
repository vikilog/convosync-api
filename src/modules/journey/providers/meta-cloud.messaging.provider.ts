import { randomUUID } from 'node:crypto';
import { prisma } from '../../../index.js';
import { getIo } from '../../../socket.js';
import { findOrReopenConversationForInbound } from '../../../services/conversationThread.service.js';
import { getWorkspaceWhatsAppCredentials } from '../../../services/whatsappCredentials.js';
import {
  formatMetaSendError,
  renderTemplateBody,
  sendWhatsAppCtaUrlMessage,
  sendWhatsAppFlowMessage,
  sendWhatsAppMessage,
  sendWhatsAppReplyButtons,
  sendWhatsAppTemplateMessage,
  sendWhatsAppTypingIndicator,
} from '../../../services/whatsapp.js';
import { sleep, typingDelayMs } from '../services/typing-indicator.service.js';
import {
  assertWhatsAppTemplateAffordable,
  chargeWhatsAppTemplateUsage,
} from '../../../services/walletUsage.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from '../../../services/templateSendHeader.js';
import { templateMessagePresentationMetadata } from '../../../services/templateMessageMetadata.js';
import { recordFlowSend } from '../../../services/whatsappFlowToken.service.js';
import type { MessagingProvider, SendMessageInput, SendMessageResult } from './messaging.provider.js';

export class MetaCloudMessagingProvider implements MessagingProvider {
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const credentials = await getWorkspaceWhatsAppCredentials(input.workspaceId);
    if (!credentials.phoneNumberId || !credentials.accessToken) {
      throw new Error('WhatsApp is not connected for this workspace');
    }

    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, workspaceId: input.workspaceId },
    });
    if (!contact) {
      throw new Error('Contact not found');
    }

    const thread = await findOrReopenConversationForInbound({
      workspaceId: input.workspaceId,
      contactId: contact.id,
      channel: 'whatsapp',
      channelAccountId: credentials.phoneNumberId,
    });
    const conversation = thread.conversation;

    let renderedBody = input.text?.trim() ?? '';
    let waMessageId: string | undefined;
    let templateCategory: string | null | undefined;
    let templateNameForCharge: string | undefined;
    let templateRecord: {
      id: string;
      category: string;
      header: string | null;
      headerFormat: string | null;
      headerMediaStorageKey: string | null;
      headerMediaMimeType: string | null;
      headerMediaFileName: string | null;
      footer: string | null;
      buttonType: string | null;
      buttonText: string | null;
      buttonUrl: string | null;
      buttonPhoneNumber: string | null;
      buttonFlowId: string | null;
    } | null = null;

    if (input.templateName || input.templateId) {
      let templateName = input.templateName;
      let language = input.language ?? 'en';
      let bodyPattern = '';
      let variables: string[] = input.variables ?? [];

      if (input.templateId) {
        const template = await prisma.template.findFirst({
          where: { id: input.templateId, workspaceId: input.workspaceId },
        });
        if (!template) throw new Error('Template not found');
        if (template.status !== 'approved') {
          throw new Error('Only approved templates can be sent from journeys');
        }
        templateName = template.name;
        language = template.language;
        bodyPattern = template.bodyPattern;
        templateRecord = template;
        templateCategory = template.category;
        templateNameForCharge = template.name;
        if (template.variables.length && variables.length < template.variables.length) {
          variables = [...variables, ...Array(template.variables.length - variables.length).fill('')];
        }
      }

      if (!templateName) {
        throw new Error('Template name is required');
      }

      renderedBody = bodyPattern
        ? renderTemplateBody(bodyPattern, variables)
        : `[Template: ${templateName}]`;

      let headerMedia:
        | {
            format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
            waMediaId: string;
            fileName?: string;
          }
        | undefined;

      if (templateRecord && isTemplateMediaHeaderFormat(templateRecord.headerFormat)) {
        headerMedia = await uploadTemplateHeaderMediaForSend(
          credentials.accessToken,
          credentials.phoneNumberId,
          input.workspaceId,
          templateRecord
        );
      }

      await assertWhatsAppTemplateAffordable({
        workspaceId: input.workspaceId,
        templateCategory,
        phoneNumberId: credentials.phoneNumberId,
      });

      const templateFlowToken = templateRecord?.buttonType === 'FLOW' ? randomUUID() : undefined;
      const result = await sendWhatsAppTemplateMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        contact.phone,
        templateName,
        language,
        variables,
        {
          ...(headerMedia ? { headerMedia } : {}),
          ...(templateFlowToken ? { flowToken: templateFlowToken } : {}),
        }
      );
      waMessageId = result.waMessageId;
      if (templateFlowToken && templateRecord?.buttonFlowId) {
        await recordFlowSend({
          flowToken: templateFlowToken,
          flowId: templateRecord.buttonFlowId,
          workspaceId: input.workspaceId,
        });
      }
    } else {
      if (!renderedBody) {
        throw new Error('Message text or template is required');
      }

      if (input.simulateTyping) {
        await maybeWhatsAppTyping(
          credentials.accessToken,
          credentials.phoneNumberId,
          conversation.id,
          renderedBody
        );
      }

      if (input.flow) {
        const result = await sendWhatsAppFlowMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          contact.phone,
          {
            bodyText: renderedBody,
            metaFlowId: input.flow.metaFlowId,
            flowToken: input.flow.flowToken,
            ctaLabel: input.flow.ctaLabel,
            firstScreenId: input.flow.firstScreenId,
            headerText: input.flow.headerText,
          }
        );
        waMessageId = result.waMessageId;
      } else if (input.ctaUrl) {
        const result = await sendWhatsAppCtaUrlMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          contact.phone,
          renderedBody,
          input.ctaButtonLabel || 'Open link',
          input.ctaUrl
        );
        waMessageId = result.waMessageId;
      } else if (input.buttons && input.buttons.length > 0) {
        const result = await sendWhatsAppReplyButtons(
          credentials.accessToken,
          credentials.phoneNumberId,
          contact.phone,
          renderedBody,
          input.buttons
        );
        waMessageId = result.waMessageId;
      } else {
        const result = await sendWhatsAppMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          contact.phone,
          renderedBody
        );
        waMessageId = result.waMessageId;
      }
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: 'agent',
        senderName: 'Journey',
        content: renderedBody,
        type:
          input.templateName || input.templateId
            ? 'template'
            : input.flow || input.ctaUrl || input.buttons?.length
              ? 'interactive'
              : 'text',
        status: 'sent',
        waMessageId,
        metadata: {
          source: 'journey',
          ...(templateRecord ? templateMessagePresentationMetadata(templateRecord) : {}),
          ...input.metadata,
        },
      },
    });

    if (input.templateName || input.templateId) {
      try {
        await chargeWhatsAppTemplateUsage({
          workspaceId: input.workspaceId,
          templateCategory,
          referenceId: message.id,
          templateName: templateNameForCharge ?? input.templateName,
          phoneNumberId: credentials.phoneNumberId,
        });
      } catch (err) {
        console.error('[wallet] Journey template debit failed', err);
      }
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: renderedBody.slice(0, 500),
        lastMessageAt: new Date(),
      },
    });

    getIo().to(input.workspaceId).emit('new_message', {
      conversationId: conversation.id,
      message,
    });
    getIo().to(input.workspaceId).emit('conversation_updated', {
      conversationId: conversation.id,
    });

    return {
      messageId: message.id,
      conversationId: conversation.id,
      waMessageId,
      renderedBody,
    };
  }
}

export function wrapMetaSendError(err: unknown): Error {
  return new Error(formatMetaSendError(err));
}

/** WA typing needs a prior inbound mid; otherwise just delay. */
async function maybeWhatsAppTyping(
  token: string,
  phoneNumberId: string,
  conversationId: string,
  text: string
): Promise<void> {
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, sender: 'contact', waMessageId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { waMessageId: true },
  });
  if (lastInbound?.waMessageId) {
    try {
      await sendWhatsAppTypingIndicator(token, phoneNumberId, lastInbound.waMessageId);
    } catch (err) {
      console.warn('[Journey] WA typing indicator failed', err);
    }
  }
  await sleep(typingDelayMs(text));
}
