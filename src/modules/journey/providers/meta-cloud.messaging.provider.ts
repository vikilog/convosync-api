import { prisma } from '../../../index.js';
import { getIo } from '../../../socket.js';
import { findOrReopenConversationForInbound } from '../../../services/conversationThread.service.js';
import { getWorkspaceWhatsAppCredentials } from '../../../services/whatsappCredentials.js';
import {
  formatMetaSendError,
  renderTemplateBody,
  sendWhatsAppMessage,
  sendWhatsAppTemplateMessage,
} from '../../../services/whatsapp.js';
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

      const result = await sendWhatsAppTemplateMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        contact.phone,
        templateName,
        language,
        variables
      );
      waMessageId = result.waMessageId;
    } else {
      if (!renderedBody) {
        throw new Error('Message text or template is required');
      }
      const result = await sendWhatsAppMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        contact.phone,
        renderedBody
      );
      waMessageId = result.waMessageId;
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: 'agent',
        senderName: 'Journey',
        content: renderedBody,
        type: input.templateName || input.templateId ? 'template' : 'text',
        status: 'sent',
        waMessageId,
        metadata: {
          source: 'journey',
          ...input.metadata,
        },
      },
    });

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
