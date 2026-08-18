import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { findWhatsAppContact, upsertWhatsAppContact } from '../lib/whatsappContact.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, renderTemplateBody, sendWhatsAppCtaUrlMessage, sendWhatsAppTemplateMessage } from './whatsapp.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';
import { extractVariableIndexes } from './metaMessageTemplates.js';
import {
  resolveWhatsAppConversationForOutbound,
} from './conversationThread.service.js';
import { getIo } from '../socket.js';

export type WhatsAppPaymentRequestDto = {
  id: string;
  contactId: string | null;
  contactName: string;
  contactPhone: string;
  amountPaise: number;
  currency: string;
  description: string;
  status: string;
  paymentLinkUrl: string | null;
  sentAt: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  createdByName: string | null;
  createdAt: string;
  sendMode: string;
  templateId: string | null;
  templateVariables: string[];
};

function mapRequest(row: {
  id: string;
  contactId: string | null;
  contactName: string;
  contactPhone: string;
  amountPaise: number;
  currency: string;
  description: string;
  status: string;
  paymentLinkUrl: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  expiresAt: Date | null;
  createdByName: string | null;
  createdAt: Date;
  sendMode: string;
  templateId: string | null;
  templateVariables: string[];
}): WhatsAppPaymentRequestDto {
  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    amountPaise: row.amountPaise,
    currency: row.currency,
    description: row.description,
    status: row.status,
    paymentLinkUrl: row.paymentLinkUrl,
    sentAt: row.sentAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    sendMode: row.sendMode,
    templateId: row.templateId,
    templateVariables: row.templateVariables ?? [],
  };
}

function formatInr(paise: number) {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function defaultTemplateVariables(input: {
  contactName: string;
  description: string;
  amountPaise: number;
}): string[] {
  const periodMatch = input.description.match(/\b(monthly|annual|yearly)\b/i);
  const period = periodMatch
    ? periodMatch[0].charAt(0).toUpperCase() + periodMatch[0].slice(1).toLowerCase()
    : 'Monthly';
  return [input.contactName.trim(), period, formatInr(input.amountPaise)];
}

function templateButtonUrlParameter(templateButtonUrl: string | null | undefined, paymentLinkUrl: string) {
  if (!templateButtonUrl?.includes('{{')) return undefined;
  const prefix = templateButtonUrl.split('{{')[0];
  if (paymentLinkUrl.startsWith(prefix)) {
    return paymentLinkUrl.slice(prefix.length).replace(/^\//, '');
  }
  try {
    const url = new URL(paymentLinkUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || paymentLinkUrl;
  } catch {
    return paymentLinkUrl;
  }
}

export class WhatsAppPayService {
  constructor(private readonly razorpay: RazorpayService) {}

  async getSummary(workspaceId: string) {
    const rows = await prisma.whatsAppPaymentRequest.findMany({
      where: { workspaceId },
      select: { status: true, amountPaise: true },
    });

    let totalCollectedPaise = 0;
    let pendingCount = 0;
    let paidCount = 0;
    let sentCount = 0;

    for (const row of rows) {
      if (row.status === 'paid') {
        paidCount += 1;
        totalCollectedPaise += row.amountPaise;
      } else if (row.status === 'sent') {
        sentCount += 1;
        pendingCount += 1;
      } else if (row.status === 'draft') {
        pendingCount += 1;
      }
    }

    return {
      totalCollectedPaise,
      pendingCount,
      paidCount,
      sentCount,
      requestCount: rows.length,
      razorpayConfigured: config.razorpay.enabled,
    };
  }

  async listRequests(workspaceId: string, status?: string) {
    const rows = await prisma.whatsAppPaymentRequest.findMany({
      where: {
        workspaceId,
        ...(status && status !== 'ALL' ? { status: status.toLowerCase() } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { requests: rows.map(mapRequest) };
  }

  async createRequest(
    workspaceId: string,
    input: {
      contactId?: string;
      contactName: string;
      contactPhone: string;
      amountPaise: number;
      description: string;
      createdByName?: string;
      sendMode?: 'plain' | 'template';
      templateId?: string;
      templateVariables?: string[];
    }
  ) {
    if (!Number.isFinite(input.amountPaise) || input.amountPaise < 100) {
      throw new Error('Amount must be at least ₹1 (100 paise)');
    }
    const description = input.description.trim();
    if (!description) throw new Error('Description is required');

    let contactId = input.contactId ?? null;
    let contactName = input.contactName.trim();
    let contactPhone = input.contactPhone.trim();

    if (contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: contactId, workspaceId },
      });
      if (!contact) throw new Error('Contact not found');
      contactName = contact.name;
      contactPhone = contact.phone;
    }

    if (!contactName || !contactPhone) {
      throw new Error('Contact name and phone are required');
    }

    const sendMode = input.sendMode === 'template' ? 'template' : 'plain';
    let templateId: string | null = null;
    let templateVariables: string[] = [];

    if (sendMode === 'template') {
      if (!input.templateId) throw new Error('Select an approved template');
      const template = await prisma.template.findFirst({
        where: { id: input.templateId, workspaceId, status: 'approved' },
      });
      if (!template) throw new Error('Approved template not found');
      templateId = template.id;
      const varCount = extractVariableIndexes(template.bodyPattern).length;
      templateVariables =
        input.templateVariables?.map((v) => v.trim()).filter(Boolean) ??
        defaultTemplateVariables({ contactName, description, amountPaise: input.amountPaise });
      if (templateVariables.length !== varCount) {
        throw new Error(`Template requires ${varCount} variable(s)`);
      }
      if (templateVariables.some((v) => !v.trim())) {
        throw new Error('All template variables must be filled in');
      }
    }

    const row = await prisma.whatsAppPaymentRequest.create({
      data: {
        workspaceId,
        contactId,
        contactName,
        contactPhone,
        amountPaise: Math.round(input.amountPaise),
        description,
        status: 'draft',
        createdByName: input.createdByName ?? null,
        sendMode,
        templateId,
        templateVariables,
      },
    });

    return { request: mapRequest(row) };
  }

  async sendRequest(workspaceId: string, requestId: string) {
    if (!config.razorpay.enabled) {
      throw new Error('Payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }

    const request = await prisma.whatsAppPaymentRequest.findFirst({
      where: { id: requestId, workspaceId },
    });
    if (!request) throw new Error('Payment request not found');
    if (request.status === 'paid') throw new Error('This payment is already completed');
    if (request.status === 'cancelled') throw new Error('This payment request was cancelled');

    let paymentLinkUrl = request.paymentLinkUrl;
    let razorpayPaymentLinkId = request.razorpayPaymentLinkId;
    let expiresAt = request.expiresAt;

    if (!paymentLinkUrl || !razorpayPaymentLinkId) {
      const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      const link = await this.razorpay.createPaymentLink({
        amountPaise: request.amountPaise,
        description: request.description,
        customerName: request.contactName,
        customerPhone: request.contactPhone,
        notes: {
          purpose: 'whatsapp_pay',
          workspaceId,
          paymentRequestId: request.id,
        },
        expireBy,
      });
      paymentLinkUrl = link.short_url;
      razorpayPaymentLinkId = link.id;
      expiresAt = link.expire_by ? new Date(link.expire_by * 1000) : new Date(expireBy * 1000);
    }

    const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
    if (!credentials.phoneNumberId) {
      throw new Error('WhatsApp phone number is not configured');
    }

    const amountLabel = formatInr(request.amountPaise);
    let waMessageId: string;
    let inboxContent: string;

    try {
      if (request.sendMode === 'template' && request.templateId) {
        const template = await prisma.template.findFirst({
          where: { id: request.templateId, workspaceId, status: 'approved' },
        });
        if (!template) throw new Error('Approved template not found');

        const varCount = extractVariableIndexes(template.bodyPattern).length;
        const bodyParams =
          request.templateVariables.length === varCount
            ? request.templateVariables
            : defaultTemplateVariables({
                contactName: request.contactName,
                description: request.description,
                amountPaise: request.amountPaise,
              });

        if (bodyParams.length !== varCount || bodyParams.some((v) => !v.trim())) {
          throw new Error('Template variables are missing or invalid');
        }

        let headerMedia:
          | {
              format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
              waMediaId: string;
              fileName?: string;
            }
          | undefined;

        if (isTemplateMediaHeaderFormat(template.headerFormat)) {
          headerMedia = await uploadTemplateHeaderMediaForSend(
            credentials.accessToken,
            credentials.phoneNumberId,
            workspaceId,
            template
          );
        }

        const sent = await sendWhatsAppTemplateMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          request.contactPhone,
          template.name,
          template.language,
          bodyParams,
          {
            ...(template.buttonType === 'URL'
              ? { buttonUrlParameter: templateButtonUrlParameter(template.buttonUrl, paymentLinkUrl) }
              : {}),
            ...(headerMedia ? { headerMedia } : {}),
          }
        );
        waMessageId = sent.waMessageId;
        inboxContent = renderTemplateBody(template.bodyPattern, bodyParams);
        if (template.buttonText?.trim()) {
          inboxContent += `\n[${template.buttonText.trim()}] ${paymentLinkUrl}`;
        }
      } else {
        const bodyText = `Hi ${request.contactName}, please complete your payment of ${amountLabel} for ${request.description}. Tap below to pay securely via UPI or card.`;
        const sent = await sendWhatsAppCtaUrlMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          request.contactPhone,
          bodyText,
          'Pay now',
          paymentLinkUrl
        );
        waMessageId = sent.waMessageId;
        inboxContent = bodyText;
      }
    } catch (err) {
      throw new Error(formatMetaSendError(err));
    }

    const contact =
      request.contactId != null
        ? await prisma.contact.findFirst({ where: { id: request.contactId, workspaceId } })
        : await findWhatsAppContact(prisma, workspaceId, request.contactPhone);

    const resolvedContact =
      contact ??
      (await upsertWhatsAppContact({
        db: prisma,
        workspaceId,
        waFrom: request.contactPhone,
        profileName: request.contactName,
      }));

    if (!request.contactId || request.contactId !== resolvedContact.id) {
      await prisma.whatsAppPaymentRequest.update({
        where: { id: request.id },
        data: { contactId: resolvedContact.id },
      });
    }

    const { conversation, created, reopened } = await resolveWhatsAppConversationForOutbound({
      workspaceId,
      contactId: resolvedContact.id,
      channel: 'whatsapp',
      channelAccountId: credentials.phoneNumberId,
    });

    const preview = `Payment request · ${amountLabel} · ${request.description}`;
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        waMessageId,
        sender: 'agent',
        senderName: 'WhatsApp Pay',
        content: `${preview}\n${inboxContent}`,
        status: 'sent',
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: preview,
        lastMessageAt: new Date(),
        channelAccountId: credentials.phoneNumberId,
      },
    });

    getIo().to(workspaceId).emit('new_message', {
      conversationId: conversation.id,
      message,
    });
    if (created || reopened) {
      getIo().to(workspaceId).emit('conversation_updated', { conversationId: conversation.id });
    }

    const updated = await prisma.whatsAppPaymentRequest.update({
      where: { id: request.id },
      data: {
        status: 'sent',
        paymentLinkUrl,
        razorpayPaymentLinkId,
        expiresAt,
        waMessageId,
        sentAt: new Date(),
      },
    });

    return { request: mapRequest(updated) };
  }

  async cancelRequest(workspaceId: string, requestId: string) {
    const request = await prisma.whatsAppPaymentRequest.findFirst({
      where: { id: requestId, workspaceId },
    });
    if (!request) throw new Error('Payment request not found');
    if (request.status === 'paid') throw new Error('Paid requests cannot be cancelled');

    const updated = await prisma.whatsAppPaymentRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled' },
    });
    return { request: mapRequest(updated) };
  }

  async refreshRequest(workspaceId: string, requestId: string) {
    const request = await prisma.whatsAppPaymentRequest.findFirst({
      where: { id: requestId, workspaceId },
    });
    if (!request) throw new Error('Payment request not found');
    if (!request.razorpayPaymentLinkId || request.status === 'paid') {
      return { request: mapRequest(request) };
    }

    const link = await this.razorpay.fetchPaymentLink(request.razorpayPaymentLinkId);
    let status = request.status;
    if (link.status === 'paid') status = 'paid';
    else if (link.status === 'expired') status = 'expired';
    else if (link.status === 'cancelled') status = 'cancelled';

    const updated = await prisma.whatsAppPaymentRequest.update({
      where: { id: request.id },
      data: {
        status,
        ...(status === 'paid' ? { paidAt: new Date() } : {}),
      },
    });
    return { request: mapRequest(updated) };
  }

  async handlePaymentLinkPaid(payload: Record<string, unknown>) {
    const paymentLink = payload.payment_link as
      | { entity?: { id?: string; notes?: Record<string, string> }; id?: string; notes?: Record<string, string> }
      | undefined;
    const entity = paymentLink?.entity ?? paymentLink;
    if (!entity?.id) return;

    const notes = entity.notes ?? {};
    if (notes.purpose !== 'whatsapp_pay') return;

    const paymentRequestId = notes.paymentRequestId;
    const workspaceId = notes.workspaceId;
    if (!paymentRequestId || !workspaceId) return;

    const request = await prisma.whatsAppPaymentRequest.findFirst({
      where: { id: paymentRequestId, workspaceId },
    });
    if (!request || request.status === 'paid') return;

    const payment = payload.payment as { entity?: { id?: string }; id?: string } | undefined;
    const paymentEntity = payment?.entity ?? payment;

    await prisma.whatsAppPaymentRequest.update({
      where: { id: request.id },
      data: {
        status: 'paid',
        paidAt: new Date(),
        razorpayPaymentId: paymentEntity?.id ?? null,
      },
    });
  }
}
