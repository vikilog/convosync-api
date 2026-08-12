/**
 * Inbox 1:1 email — create/continue email Conversation + Message after EmailService.send.
 */
import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import { getEmailService } from '../modules/email/container.js';
import { stripHtmlToText } from '../modules/email/utils/template-variables.js';
import {
  interpolateContactTokens,
  resolveCampaignEmailVariables,
} from './campaignEmailVariables.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';

export type InboxEmailSendInput = {
  contactId: string;
  subject: string;
  text?: string;
  html?: string;
  templateId?: string;
  senderName?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapPlainTextAsHtml(text: string): string {
  // stripHtmlToText leaves entities like &nbsp;; decode before escape so Gmail doesn't show literals.
  const plain = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;white-space:pre-wrap;">${escapeHtml(plain)}</div>`;
}

function asVariableNames(variables: unknown): string[] {
  if (!Array.isArray(variables)) return [];
  return variables.map((v) => String(v)).filter(Boolean);
}

export async function sendInboxEmailToContact(
  workspaceId: string,
  input: InboxEmailSendInput
) {
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId },
  });
  if (!contact) {
    throw Object.assign(new Error('Contact not found'), { statusCode: 404 });
  }

  const to = contact.email?.trim();
  if (!to) {
    throw Object.assign(new Error('Contact has no email address'), { statusCode: 400 });
  }

  const campaignContact = {
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    customFields: contact.customFields,
  };

  const templateId = input.templateId?.trim() || undefined;
  let subject: string;
  let text: string | undefined;
  let html: string | undefined;
  let log: Awaited<ReturnType<ReturnType<typeof getEmailService>['sendEmail']>>;

  if (templateId) {
    // Same path as campaigns: EmailService loads HTML from template + interpolates variables.
    const tpl = await prisma.emailTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: { id: true, variables: true },
    });
    if (!tpl) {
      throw Object.assign(new Error('Email template not found'), { statusCode: 404 });
    }

    const variables = resolveCampaignEmailVariables(
      campaignContact,
      {},
      asVariableNames(tpl.variables)
    );

    log = await getEmailService().sendEmail(workspaceId, {
      to,
      templateId: tpl.id,
      variables,
      contactId: contact.id,
    });

    subject = log.subject;
    text = input.text?.trim()
      ? interpolateContactTokens(input.text.trim(), campaignContact)
      : undefined;
    html = undefined;
  } else {
    const subjectRaw = input.subject?.trim() ?? '';
    const textRaw = input.text?.trim() ?? '';
    const htmlRaw = input.html?.trim() ?? '';
    if (!subjectRaw) {
      throw Object.assign(new Error('Subject is required'), { statusCode: 400 });
    }
    if (!textRaw && !htmlRaw) {
      throw Object.assign(new Error('Message is required'), { statusCode: 400 });
    }

    subject = interpolateContactTokens(subjectRaw, campaignContact);
    text = textRaw ? interpolateContactTokens(textRaw, campaignContact) : undefined;
    html = htmlRaw
      ? interpolateContactTokens(htmlRaw, campaignContact)
      : text
        ? wrapPlainTextAsHtml(text)
        : undefined;

    // Custom compose: always multipart html + text (never HTML source as text/plain alone).
    log = await getEmailService().sendEmail(workspaceId, {
      to,
      subject,
      text: text || (html ? stripHtmlToText(html) : undefined),
      html,
      contactId: contact.id,
    });
  }

  const { conversation } = await findOrReopenConversationForInbound({
    workspaceId,
    contactId: contact.id,
    channel: 'email',
  });

  const previewText = text || (html ? stripHtmlToText(html) : subject);
  const content = subject === previewText ? previewText : `${subject}\n\n${previewText}`;

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waMessageId: log.messageId ?? undefined,
      sender: 'agent',
      senderName: input.senderName?.trim() || 'Agent',
      content,
      type: 'email',
      status: 'sent',
      metadata: {
        emailLogId: log.id,
        subject,
        ...(templateId ? { templateId } : {}),
        events: [{ type: 'sent', at: new Date().toISOString() }],
      },
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conversation.id, workspaceId },
    data: {
      lastMessage: content.slice(0, 500),
      lastMessageAt: new Date(),
      status: 'open',
    },
  });

  getIo().to(workspaceId).emit('new_message', {
    conversationId: conversation.id,
    message,
  });
  getIo().to(workspaceId).emit('conversation_updated', {
    conversationId: conversation.id,
  });

  const full = await prisma.conversation.findFirst({
    where: { id: conversation.id, workspaceId },
    include: { contact: true, agent: true },
  });

  return { conversation: full, message, emailLog: log };
}
