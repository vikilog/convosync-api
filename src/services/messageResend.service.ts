import type { Message } from '@prisma/client';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import {
  beginResend,
  canResendStatus,
  finishResend,
  mergeSendErrorMetadata,
} from '../lib/messageResendStatus.js';
import {
  isInstagramPhone,
  parseInstagramScopedUserId,
  parseMessengerPsid,
} from '../lib/channelContact.js';
import { getWorkspaceInstagramCredentials } from './instagramCredentials.js';
import { formatInstagramSendError, sendInstagramMessage } from './instagram.js';
import { getWorkspaceMessengerCredentials } from './messengerCredentials.js';
import { formatMessengerSendError, sendMessengerMessage } from './messenger.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import {
  formatMetaSendError,
  sendWhatsAppMessage,
  sendWhatsAppTemplateMessage,
} from './whatsapp.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';
import {
  resolveOutboundInstagramKind,
  sendInstagramMediaMessage,
} from './instagramMedia.js';
import { sendMessengerMediaMessage } from './messenger.js';
import { stageMediaForMetaFetch } from './mediaStaging.js';
import {
  readMessageMediaFile,
  resolveOutboundWhatsAppKind,
  sendWhatsAppMediaMessage,
  uploadWhatsAppMedia,
  type MessageMediaMetadata,
} from './whatsappMedia.js';
import {
  assertInstagramMessageAffordable,
  assertWhatsAppTemplateAffordable,
  chargeInstagramMessageUsage,
  chargeWhatsAppTemplateUsage,
} from './walletUsage.js';
import { InsufficientWalletBalanceError } from './wallet.service.js';

function meta(message: Message): Record<string, unknown> {
  const raw = message.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

function emitStatus(workspaceId: string, messageId: string, status: string, sendError?: string) {
  getIo().to(workspaceId).emit('message_status', {
    messageId,
    status,
    ...(sendError ? { errors: [{ message: sendError }] } : {}),
  });
}

async function markPending(message: Message): Promise<Message> {
  const next = beginResend(message.retryCount);
  return prisma.message.update({
    where: { id: message.id },
    data: {
      status: next.status,
      retryCount: next.retryCount,
    },
  });
}

async function markResult(
  message: Message,
  workspaceId: string,
  ok: boolean,
  opts?: { waMessageId?: string; sendError?: string }
): Promise<Message> {
  const status = finishResend(ok);
  const metadata = opts?.sendError
    ? mergeSendErrorMetadata(message.metadata, opts.sendError)
    : meta(message);
  if (ok && metadata.sendError) delete metadata.sendError;
  const prevEvents = Array.isArray(metadata.events) ? [...metadata.events] : [];
  const event: Record<string, unknown> = { type: status, at: new Date().toISOString() };
  if (opts?.sendError) event.detail = opts.sendError;
  prevEvents.push(event);
  // ponytail: same 40-event cap as WA webhook merge
  metadata.events = prevEvents.length > 40 ? prevEvents.slice(-40) : prevEvents;

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      status,
      ...(opts?.waMessageId ? { waMessageId: opts.waMessageId } : {}),
      metadata: metadata as object,
    },
  });
  emitStatus(workspaceId, updated.id, status, opts?.sendError);
  return updated;
}

async function resendText(
  message: Message,
  workspaceId: string,
  channel: string,
  channelAccountId: string | null,
  phone: string
): Promise<Message> {
  if (channel === 'instagram' || isInstagramPhone(phone)) {
    const igUserId = parseInstagramScopedUserId(phone);
    if (!igUserId) throw new Error('Contact has no Instagram user id');
    const credentials = await getWorkspaceInstagramCredentials(workspaceId, channelAccountId);
    await assertInstagramMessageAffordable(workspaceId);
    const lastContactMsg = await prisma.message.findFirst({
      where: { conversationId: message.conversationId, sender: 'contact', waMessageId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { waMessageId: true },
    });
    const sent = await sendInstagramMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      igUserId,
      message.content,
      {
        replyToMid: lastContactMsg?.waMessageId || undefined,
        instagramUserId: credentials.instagramUserId,
      }
    );
    const updated = await markResult(message, workspaceId, true, { waMessageId: sent.messageId });
    try {
      await chargeInstagramMessageUsage({ workspaceId, referenceId: `${message.id}:retry:${updated.retryCount}` });
    } catch (err) {
      console.error('[resend] Instagram wallet debit failed', err);
    }
    return updated;
  }

  if (channel === 'messenger') {
    const psid = parseMessengerPsid(phone);
    if (!psid) throw new Error('Contact has no Messenger user id');
    const credentials = await getWorkspaceMessengerCredentials(workspaceId, channelAccountId);
    const sent = await sendMessengerMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      psid,
      message.content
    );
    return markResult(message, workspaceId, true, { waMessageId: sent.messageId });
  }

  const credentials = await getWorkspaceWhatsAppCredentials(workspaceId, channelAccountId);
  if (!credentials.phoneNumberId) {
    throw new Error('No WhatsApp phone number configured for this workspace');
  }
  const sent = await sendWhatsAppMessage(
    credentials.accessToken,
    credentials.phoneNumberId,
    phone,
    message.content
  );
  return markResult(message, workspaceId, true, { waMessageId: sent.waMessageId });
}

async function resendTemplate(
  message: Message,
  workspaceId: string,
  channelAccountId: string | null,
  phone: string
): Promise<Message> {
  const m = meta(message);
  const templateId = typeof m.templateId === 'string' ? m.templateId : null;
  if (!templateId) throw new Error('Original template payload is missing; cannot resend');

  const template = await prisma.template.findFirst({
    where: { id: templateId, workspaceId },
  });
  if (!template) throw new Error('Template not found');
  if (template.status !== 'approved') {
    throw new Error('Only approved templates can be resent');
  }

  const bodyParams = Array.isArray(m.variables)
    ? m.variables.map((v) => String(v))
    : [];

  const credentials = await getWorkspaceWhatsAppCredentials(workspaceId, channelAccountId);
  if (!credentials.phoneNumberId) {
    throw new Error('No WhatsApp phone number configured for this workspace');
  }

  let headerMedia:
    | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; waMediaId: string; fileName?: string }
    | undefined;
  if (isTemplateMediaHeaderFormat(template.headerFormat)) {
    headerMedia = await uploadTemplateHeaderMediaForSend(
      credentials.accessToken,
      credentials.phoneNumberId,
      template
    );
  }

  await assertWhatsAppTemplateAffordable({
    workspaceId,
    templateCategory: template.category,
    phoneNumberId: credentials.phoneNumberId,
  });
  const sent = await sendWhatsAppTemplateMessage(
    credentials.accessToken,
    credentials.phoneNumberId,
    phone,
    template.name,
    template.language,
    bodyParams,
    headerMedia ? { headerMedia } : undefined
  );

  const updated = await markResult(message, workspaceId, true, { waMessageId: sent.waMessageId });
  try {
    await chargeWhatsAppTemplateUsage({
      workspaceId,
      templateCategory: template.category,
      referenceId: `${message.id}:retry:${updated.retryCount}`,
      templateName: template.name,
      phoneNumberId: credentials.phoneNumberId,
    });
  } catch (err) {
    console.error('[resend] Wallet debit after template resend failed', err);
  }
  return updated;
}

async function resendMedia(
  message: Message,
  workspaceId: string,
  channel: string,
  channelAccountId: string | null,
  phone: string
): Promise<Message> {
  const m = meta(message) as MessageMediaMetadata & Record<string, unknown>;
  if (!m.storageKey) throw new Error('Original media file is missing; cannot resend');

  const { buffer, mimeType } = await readMessageMediaFile(m.storageKey);
  const fileName = m.fileName || `attachment-${message.id}`;
  const caption = typeof m.caption === 'string' ? m.caption : '';
  const effectiveMime = m.mimeType || mimeType;

  if (channel === 'instagram') {
    const igUserId = parseInstagramScopedUserId(phone);
    if (!igUserId) throw new Error('Contact has no Instagram user id');
    const credentials = await getWorkspaceInstagramCredentials(workspaceId, channelAccountId);
    await assertInstagramMessageAffordable(workspaceId);
    const igKind = resolveOutboundInstagramKind(effectiveMime);
    const staged = await stageMediaForMetaFetch(buffer, effectiveMime, fileName);
    const sent = await sendInstagramMediaMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      igUserId,
      igKind,
      staged.publicUrl
    );
    const updated = await markResult(message, workspaceId, true, { waMessageId: sent.messageId });
    try {
      await chargeInstagramMessageUsage({
        workspaceId,
        referenceId: `${message.id}:retry:${updated.retryCount}`,
      });
    } catch (err) {
      console.error('[resend] Instagram media wallet debit failed', err);
    }
    return updated;
  }

  if (channel === 'messenger') {
    const psid = parseMessengerPsid(phone);
    if (!psid) throw new Error('Contact has no Messenger user id');
    const credentials = await getWorkspaceMessengerCredentials(workspaceId, channelAccountId);
    const metaKind = resolveOutboundInstagramKind(effectiveMime);
    const staged = await stageMediaForMetaFetch(buffer, effectiveMime, fileName);
    const sent = await sendMessengerMediaMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      psid,
      metaKind,
      staged.publicUrl
    );
    return markResult(message, workspaceId, true, { waMessageId: sent.messageId });
  }

  const credentials = await getWorkspaceWhatsAppCredentials(workspaceId, channelAccountId);
  if (!credentials.phoneNumberId) {
    throw new Error('No WhatsApp phone number configured for this workspace');
  }
  const kind = resolveOutboundWhatsAppKind(effectiveMime);
  const waMediaId = await uploadWhatsAppMedia(
    credentials.accessToken,
    credentials.phoneNumberId,
    buffer,
    effectiveMime,
    fileName
  );
  const sent = await sendWhatsAppMediaMessage(
    credentials.accessToken,
    credentials.phoneNumberId,
    phone,
    kind,
    waMediaId,
    caption,
    fileName
  );
  return markResult(message, workspaceId, true, { waMessageId: sent.waMessageId });
}

function formatSendErr(err: unknown, channel: string): string {
  if (err instanceof InsufficientWalletBalanceError) return err.message;
  if (channel === 'instagram') return formatInstagramSendError(err);
  if (channel === 'messenger') return formatMessengerSendError(err);
  return formatMetaSendError(err);
}

/**
 * Resend a failed inbox/campaign Message through the same channel send path.
 * Status: failed → resend_pending → resent | failed
 */
export async function resendFailedMessage(
  messageId: string,
  workspaceId: string
): Promise<Message> {
  const message = await prisma.message.findFirst({
    where: { id: messageId },
    include: {
      conversation: {
        include: { contact: true },
      },
    },
  });
  if (!message || message.conversation.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Message not found'), { statusCode: 404 });
  }
  if (message.sender === 'contact') {
    throw Object.assign(new Error('Cannot resend inbound messages'), { statusCode: 400 });
  }
  if (!canResendStatus(message.status)) {
    throw Object.assign(
      new Error(`Message status "${message.status}" cannot be resent`),
      { statusCode: 409 }
    );
  }

  const channel = message.conversation.channel || 'whatsapp';
  const phone = message.conversation.contact?.phone;
  if (!phone) {
    throw Object.assign(new Error('Contact has no destination address'), { statusCode: 400 });
  }

  const pending = await markPending(message);
  emitStatus(workspaceId, pending.id, 'resend_pending');

  try {
    const type = (message.type || 'text').toLowerCase();
    if (type === 'template') {
      return await resendTemplate(
        pending,
        workspaceId,
        message.conversation.channelAccountId,
        phone
      );
    }
    if (type === 'image' || type === 'video' || type === 'audio' || type === 'document' || type === 'sticker') {
      return await resendMedia(
        pending,
        workspaceId,
        channel,
        message.conversation.channelAccountId,
        phone
      );
    }
    return await resendText(
      pending,
      workspaceId,
      channel,
      message.conversation.channelAccountId,
      phone
    );
  } catch (err) {
    const sendError = formatSendErr(err, channel);
    await markResult(pending, workspaceId, false, { sendError });
    if (err instanceof InsufficientWalletBalanceError) {
      throw Object.assign(new Error(err.message), { statusCode: 402, code: err.code });
    }
    throw Object.assign(new Error(sendError), { statusCode: 502 });
  }
}
