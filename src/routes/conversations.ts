import { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, scopedUpdateData } from '../middleware/workspaceScope.js';
import { isWorkspaceMember } from '../services/workspaceMembers.js';
import {
  applyConversationAssignee,
  ConversationAssigneeError,
} from '../services/conversation-assignee.service.js';
import {
  listConversationEvents,
  recordConversationEvent,
  resolvePriorAiAssignee,
} from '../services/conversation-event.service.js';
import {
  isConversationAssigneeType,
  type ConversationAssigneeType,
} from '../types/conversation-assignee.js';
import { isAiAssigneeType } from '../types/conversation-event.js';
import {
  isInstagramPhone,
  isInstagramSource,
  isMessengerPhone,
  isMessengerSource,
  parseInstagramScopedUserId,
  parseMessengerPsid,
  parseTelegramChatId,
} from '../lib/channelContact.js';
import { getWorkspaceInstagramCredentials } from '../services/instagramCredentials.js';
import { formatInstagramSendError, sendInstagramMessage } from '../services/instagram.js';
import { refreshInstagramContactProfile } from '../services/instagramContactProfile.js';
import { getWorkspaceMessengerCredentials } from '../services/messengerCredentials.js';
import { formatMessengerSendError, sendMessengerMessage } from '../services/messenger.js';
import { getWorkspaceTelegramCredentials } from '../services/telegramCredentials.js';
import {
  formatTelegramSendError,
  sendTelegramMedia,
  sendTelegramMediaGroup,
  sendTelegramMessage,
} from '../services/telegramConnect.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import { extractVariableIndexes } from '../services/metaMessageTemplates.js';
import { deleteConversationThread } from '../services/conversation-delete.service.js';
import {
  consolidateWorkspaceWhatsAppDuplicates,
  dedupeConversationsByContact,
  findOrReopenConversationForInbound,
  onConversationResolved,
} from '../services/conversationThread.service.js';
import {
  formatMetaSendError,
  renderTemplateBody,
  sendWhatsAppMessage,
  sendWhatsAppTemplateMessage,
} from '../services/whatsapp.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from '../services/templateSendHeader.js';
import {
  resolveOutboundInstagramKind,
  sendInstagramMediaMessage,
} from '../services/instagramMedia.js';
import {
  sendMessengerMediaMessage,
} from '../services/messenger.js';
import { stageMediaForMetaFetch } from '../services/mediaStaging.js';
import {
  previewForMessage,
  readMessageMediaFile,
  resolveOutboundWhatsAppKind,
  saveMessageMediaFile,
  sendWhatsAppMediaMessage,
  uploadWhatsAppMedia,
  type MessageMediaMetadata,
} from '../services/whatsappMedia.js';
import {
  assertWhatsAppTemplateAffordable,
  assertInstagramMessageAffordable,
  chargeInstagramMessageUsage,
  chargeWhatsAppTemplateUsage,
} from '../services/walletUsage.js';
import { InsufficientWalletBalanceError } from '../services/wallet.service.js';
import { persistFailedOutboundMessage } from '../services/persistFailedOutbound.js';
import { resendFailedMessage } from '../services/messageResend.service.js';
import { mergeSendErrorMetadata } from '../lib/messageResendStatus.js';
import { resolveMembershipAccess } from '../services/workspaceMemberAdmin.js';
import {
  buildConversationScopeWhere,
  conversationMatchesInboxScope,
  type InboxScope,
} from '../services/inboxScope.js';
import { contentDisposition } from '../utils/contentDisposition.js';
import { sendInboxEmailToContact } from '../services/inboxEmailSend.js';

function denyInboxScope(reply: FastifyReply) {
  return reply.code(403).send({
    error: 'You do not have access to this inbox',
    code: 'inbox_scope_denied',
  });
}

function assertConversationInScope(
  conversation: { channel: string; channelAccountId: string | null },
  inboxScope: InboxScope,
  reply: FastifyReply
) {
  if (!conversationMatchesInboxScope(conversation, inboxScope)) {
    denyInboxScope(reply);
    return false;
  }
  return true;
}

export default async function conversationRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  fastify.get('/', auth, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { status, assignedTo, channel } = request.query as {
      status?: string;
      assignedTo?: string;
      channel?: string;
    };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const scopeWhere = buildConversationScopeWhere(access.inboxScope);
    const rows = await prisma.conversation.findMany({
      where: {
        workspaceId,
        ...(scopeWhere ?? {}),
        ...(status && { status }),
        ...(assignedTo && { assignedTo }),
        ...(channel && { channel }),
      },
      include: { contact: true, agent: true },
      orderBy: { lastMessageAt: 'desc' },
    });
    const deduped = dedupeConversationsByContact(rows);
    if (deduped.length < rows.length) {
      void consolidateWorkspaceWhatsAppDuplicates(workspaceId).catch((err) => {
        request.log.warn({ err }, 'background WhatsApp duplicate consolidation failed');
      });
    }
    return deduped;
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    let conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, agent: true, messages: { orderBy: { createdAt: 'asc' }, take: 50 } },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    if (conv.channel === 'instagram' && conv.contact) {
      const instagramUserId = parseInstagramScopedUserId(conv.contact.phone);
      if (instagramUserId) {
        try {
          const credentials = await getWorkspaceInstagramCredentials(
            workspaceId,
            conv.channelAccountId
          );
          await refreshInstagramContactProfile({
            contact: conv.contact,
            senderId: instagramUserId,
            pageAccessToken: credentials.pageAccessToken,
            businessInstagramUserId: credentials.instagramUserId,
          });
          const refreshedContact = await prisma.contact.findFirst({
            where: { id: conv.contact.id },
          });
          if (refreshedContact) {
            conv = { ...conv, contact: refreshedContact };
          }
        } catch (err) {
          request.log.warn({ err, conversationId: id }, 'Instagram profile refresh skipped');
        }
      }
    }

    return conv;
  });

  /** Start or resume an open WhatsApp thread with an existing contact */
  fastify.post('/open', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const access = await resolveMembershipAccess(userId, workspaceId);
    const { contactId, phoneNumberId } = request.body as {
      contactId?: string;
      phoneNumberId?: string;
    };

    if (!contactId) {
      return reply.code(400).send({ error: 'contactId is required' });
    }

    const contact = await prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) {
      return reply.code(404).send({ error: 'Contact not found' });
    }

    let channel: 'whatsapp' | 'instagram' | 'messenger' = 'whatsapp';
    if (isInstagramSource(contact.source) || isInstagramPhone(contact.phone)) {
      channel = 'instagram';
    } else if (isMessengerSource(contact.source) || isMessengerPhone(contact.phone)) {
      channel = 'messenger';
    }

    let channelAccountId: string | null | undefined;
    if (channel === 'instagram') {
      channelAccountId = (
        await prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: 'desc' },
        })
      )?.pageId;
    } else if (channel === 'messenger') {
      channelAccountId = (
        await prisma.messengerAccount.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: 'desc' },
        })
      )?.pageId;
    } else if (phoneNumberId?.trim()) {
      const account = await prisma.whatsAppPhoneAccount.findFirst({
        where: { workspaceId, phoneNumberId: phoneNumberId.trim() },
        select: { phoneNumberId: true },
      });
      if (!account) {
        return reply.code(400).send({ error: 'WhatsApp number not found for this workspace' });
      }
      channelAccountId = account.phoneNumberId;
    } else {
      channelAccountId = (
        await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { waNumberId: true },
        })
      )?.waNumberId;
    }

    if (
      !conversationMatchesInboxScope(
        { channel, channelAccountId: channelAccountId ?? null },
        access.inboxScope
      )
    ) {
      return denyInboxScope(reply);
    }

    const { conversation: conv } = await findOrReopenConversationForInbound({
      workspaceId,
      contactId,
      channel,
      channelAccountId,
    });

    return reply.send(
      await prisma.conversation.findFirst({
        where: { id: conv.id, workspaceId },
        include: { contact: true, agent: true },
      })
    );
  });

  /** 1:1 email from Inbox New Conversation — creates/continues channel=email thread */
  fastify.post('/email/send', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const access = await resolveMembershipAccess(userId, workspaceId);
    const body = request.body as {
      contactId?: string;
      subject?: string;
      text?: string;
      html?: string;
      templateId?: string;
    };

    if (!body.contactId?.trim()) {
      return reply.code(400).send({ error: 'contactId is required' });
    }

    if (
      !conversationMatchesInboxScope(
        { channel: 'email', channelAccountId: null },
        access.inboxScope
      )
    ) {
      return denyInboxScope(reply);
    }

    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    try {
      const result = await sendInboxEmailToContact(workspaceId, {
        contactId: body.contactId.trim(),
        subject: body.subject ?? '',
        text: body.text,
        html: body.html,
        templateId: body.templateId,
        senderName: agent?.name ?? undefined,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const statusCode =
        err && typeof err === 'object' && 'statusCode' in err
          ? Number((err as { statusCode?: number }).statusCode)
          : 400;
      return reply.code(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 400).send({
        error: err instanceof Error ? err.message : 'Failed to send email',
      });
    }
  });

  fastify.get('/:id/messages', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string; before?: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    if (conv.unreadCount > 0) {
      await prisma.conversation.updateMany({
        where: { id, workspaceId },
        data: { unreadCount: 0 },
      });
      getIo().to(workspaceId).emit('conversation_updated', { conversationId: id });
    }

    // Heal IG Ask Question waits if DMs arrived without webhook resume.
    if (conv.channel === 'instagram' && conv.contactId) {
      try {
        const { getInstagramJourneyContainer } = await import(
          '../modules/instagram-journey/container.js'
        );
        await getInstagramJourneyContainer(prisma).triggerService.recoverWaitingFromRecentReplies(
          workspaceId,
          conv.contactId
        );
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.message : err },
          'ig journey recover on messages failed'
        );
      }
    }

    const limitRaw = Number(query.limit);
    const before = typeof query.before === 'string' ? query.before.trim() : '';
    const usePagination = Number.isFinite(limitRaw) && limitRaw > 0;
    const events = await listConversationEvents(id);

    if (!usePagination && !before) {
      const messages = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      });
      return { messages, events };
    }

    const limit = Math.min(100, Math.max(1, usePagination ? limitRaw : 20));

    if (before) {
      const cursor = await prisma.message.findFirst({
        where: { id: before, conversationId: id },
        select: { createdAt: true },
      });
      if (!cursor) return reply.code(400).send({ error: 'Invalid before cursor' });

      const older = await prisma.message.findMany({
        where: { conversationId: id, createdAt: { lt: cursor.createdAt } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      const total = await prisma.message.count({ where: { conversationId: id } });
      return {
        messages: older.reverse(),
        events,
        hasMore: older.length === limit,
        total,
      };
    }

    const latest = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const total = await prisma.message.count({ where: { conversationId: id } });
    return {
      messages: latest.reverse(),
      events,
      hasMore: total > limit,
      total,
    };
  });

  fastify.get('/:id/events', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      select: { channel: true, channelAccountId: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;
    return listConversationEvents(id);
  });

  fastify.post('/:id/takeover', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      select: {
        channel: true,
        channelAccountId: true,
        assigneeType: true,
        assigneeId: true,
      },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    if (!isAiAssigneeType(conv.assigneeType)) {
      return reply.code(400).send({ error: 'Conversation is not assigned to AI' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const actorName = user?.name?.trim() || 'Agent';

    try {
      await applyConversationAssignee(
        workspaceId,
        id,
        { assigneeType: 'user', assigneeId: userId },
        { actorType: 'HUMAN', actorId: userId, actorName }
      );
    } catch (err) {
      if (err instanceof ConversationAssigneeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    await recordConversationEvent({
      conversationId: id,
      workspaceId,
      type: 'HUMAN_TAKEOVER',
      actorType: 'HUMAN',
      actorId: userId,
      actorName,
      metadata: {
        previousAssigneeType: conv.assigneeType,
        previousAssigneeId: conv.assigneeId,
      },
    });

    getIo().to(workspaceId).emit('conversation_updated', {
      conversationId: id,
      assigneeType: 'user',
      assigneeId: userId,
      reason: 'takeover',
    });

    return prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, agent: true },
    });
  });

  fastify.post('/:id/release-to-ai', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      select: {
        channel: true,
        channelAccountId: true,
        assigneeType: true,
        assigneeId: true,
      },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    if (conv.assigneeType !== 'user') {
      return reply.code(400).send({ error: 'Conversation is not handled by a human' });
    }

    const prior = await resolvePriorAiAssignee(id);
    if (!prior) {
      return reply.code(400).send({ error: 'No prior AI assignee to restore' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const actorName = user?.name?.trim() || 'Agent';

    try {
      await applyConversationAssignee(
        workspaceId,
        id,
        { assigneeType: prior.assigneeType, assigneeId: prior.assigneeId },
        { actorType: 'HUMAN', actorId: userId, actorName }
      );
    } catch (err) {
      if (err instanceof ConversationAssigneeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    await recordConversationEvent({
      conversationId: id,
      workspaceId,
      type: 'HUMAN_RELEASED_TO_AI',
      actorType: 'HUMAN',
      actorId: userId,
      actorName,
      metadata: {
        assigneeType: prior.assigneeType,
        assigneeId: prior.assigneeId,
      },
    });

    getIo().to(workspaceId).emit('conversation_updated', {
      conversationId: id,
      assigneeType: prior.assigneeType,
      assigneeId: prior.assigneeId,
      reason: 'release_to_ai',
    });

    return prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, agent: true },
    });
  });

  fastify.post('/:id/messages', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };
    const text = typeof content === 'string' ? content.trim() : '';

    if (!text) {
      return reply.code(400).send({ error: 'Message cannot be empty' });
    }

    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    if (conv.channel === 'instagram') {
      const instagramUserId = parseInstagramScopedUserId(conv.contact?.phone || '');
      if (!instagramUserId) {
        return reply.code(400).send({ error: 'Contact has no Instagram user id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceInstagramCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Instagram not connected',
        });
      }

      let messageId: string | undefined;
      try {
        await assertInstagramMessageAffordable(workspaceId);
        const lastContactMsg = await prisma.message.findFirst({
          where: { conversationId: id, sender: 'contact', waMessageId: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { waMessageId: true, createdAt: true },
        });
        const sent = await sendInstagramMessage(
          credentials.pageId,
          credentials.pageAccessToken,
          instagramUserId,
          text,
          {
            replyToMid: lastContactMsg?.waMessageId || undefined,
            instagramUserId: credentials.instagramUserId,
          }
        );
        messageId = sent.messageId;
      } catch (err) {
        if (err instanceof InsufficientWalletBalanceError) {
          return reply.code(402).send({ error: err.message, code: err.code });
        }
        request.log.error({ err }, 'Instagram send failed');
        const sendError = formatInstagramSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content: text,
          sendError,
        });
        return reply.code(502).send({ error: sendError, message: failed });
      }

      const message = await prisma.message.create({
        data: {
          conversationId: id,
          waMessageId: messageId,
          sender: 'agent',
          senderName: agent?.name ?? 'Agent',
          content: text,
          status: 'sent',
        },
      });

      try {
        await chargeInstagramMessageUsage({
          workspaceId,
          referenceId: message.id,
        });
      } catch (err) {
        request.log.error({ err }, 'Instagram wallet debit failed');
      }

      await prisma.conversation.updateMany({
        where: { id, workspaceId },
        data: { lastMessage: text, lastMessageAt: new Date(), channelAccountId: credentials.pageId },
      });

      getIo().to(workspaceId).emit('new_message', { conversationId: id, message });
      return reply.code(201).send(message);
    }

    if (conv.channel === 'messenger') {
      const psid = parseMessengerPsid(conv.contact?.phone || '');
      if (!psid) {
        return reply.code(400).send({ error: 'Contact has no Messenger user id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceMessengerCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Messenger not connected',
        });
      }

      let messageId: string | undefined;
      try {
        const sent = await sendMessengerMessage(
          credentials.pageId,
          credentials.pageAccessToken,
          psid,
          text
        );
        messageId = sent.messageId;
      } catch (err) {
        request.log.error({ err }, 'Messenger send failed');
        const sendError = formatMessengerSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content: text,
          sendError,
        });
        return reply.code(502).send({ error: sendError, message: failed });
      }

      const message = await prisma.message.create({
        data: {
          conversationId: id,
          waMessageId: messageId,
          sender: 'agent',
          senderName: agent?.name ?? 'Agent',
          content: text,
          status: 'sent',
        },
      });

      await prisma.conversation.updateMany({
        where: { id, workspaceId },
        data: { lastMessage: text, lastMessageAt: new Date(), channelAccountId: credentials.pageId },
      });

      getIo().to(workspaceId).emit('new_message', { conversationId: id, message });
      return reply.code(201).send(message);
    }

    if (conv.channel === 'telegram') {
      const chatId = parseTelegramChatId(conv.contact?.phone || '');
      if (!chatId) {
        return reply.code(400).send({ error: 'Contact has no Telegram chat id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceTelegramCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Telegram not connected',
        });
      }

      let messageId: string | undefined;
      try {
        const sent = await sendTelegramMessage(credentials.botToken, chatId, text);
        messageId = sent.messageId;
      } catch (err) {
        request.log.error({ err }, 'Telegram send failed');
        const sendError = formatTelegramSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content: text,
          sendError,
        });
        return reply.code(502).send({ error: sendError, message: failed });
      }

      const message = await prisma.message.create({
        data: {
          conversationId: id,
          waMessageId: messageId,
          sender: 'agent',
          senderName: agent?.name ?? 'Agent',
          content: text,
          status: 'sent',
        },
      });

      await prisma.conversation.updateMany({
        where: { id, workspaceId },
        data: { lastMessage: text, lastMessageAt: new Date(), channelAccountId: credentials.botId },
      });

      getIo().to(workspaceId).emit('new_message', { conversationId: id, message });
      return reply.code(201).send(message);
    }

    if (!conv.contact?.phone) {
      return reply.code(400).send({ error: 'Contact has no phone number' });
    }

    let credentials;
    try {
      credentials = await getWorkspaceWhatsAppCredentials(workspaceId, conv.channelAccountId);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'WhatsApp not connected',
      });
    }

    if (!credentials.phoneNumberId) {
      return reply.code(400).send({ error: 'No WhatsApp phone number configured for this workspace' });
    }

    let waMessageId: string | undefined;
    try {
      const sent = await sendWhatsAppMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        conv.contact.phone,
        text
      );
      waMessageId = sent.waMessageId;
    } catch (err) {
      request.log.error({ err }, 'WhatsApp send failed');
      const sendError = formatMetaSendError(err);
      const failed = await persistFailedOutboundMessage({
        workspaceId,
        conversationId: id,
        senderName: agent?.name ?? 'Agent',
        content: text,
        sendError,
      });
      return reply.code(502).send({ error: sendError, message: failed });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        waMessageId,
        sender: 'agent',
        senderName: agent?.name ?? 'Agent',
        content: text,
        status: 'sent',
      },
    });

    await prisma.conversation.updateMany({
      where: { id, workspaceId },
      data: {
        lastMessage: text,
        lastMessageAt: new Date(),
        channelAccountId: credentials.phoneNumberId,
      },
    });

    getIo().to(workspaceId).emit('new_message', { conversationId: id, message });

    return reply.code(201).send(message);
  });

  fastify.post('/:id/messages/template', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    let templateId: string | undefined;
    let variables: string[] = [];
    let headerMediaBuffer: Buffer | null = null;
    let headerMediaMimeType = '';
    let headerMediaFileName = '';

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'headerMedia') {
          headerMediaBuffer = await part.toBuffer();
          headerMediaMimeType = part.mimetype || 'application/octet-stream';
          headerMediaFileName = part.filename || 'file';
        } else if (part.type === 'field') {
          if (part.fieldname === 'templateId') {
            templateId = String(part.value ?? '').trim() || undefined;
          }
          if (part.fieldname === 'variables') {
            try {
              const parsed = JSON.parse(String(part.value ?? '[]'));
              variables = Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
            } catch {
              return reply.code(400).send({ error: 'Invalid variables payload' });
            }
          }
        }
      }
    } else {
      const body = request.body as {
        templateId?: string;
        variables?: string[];
      };
      templateId = body.templateId;
      variables = Array.isArray(body.variables) ? body.variables.map((v) => String(v)) : [];
    }

    if (!templateId) {
      return reply.code(400).send({ error: 'templateId is required' });
    }

    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;
    if (conv.channel === 'instagram') {
      return reply.code(400).send({ error: 'Templates are not supported for Instagram DMs yet' });
    }
    if (conv.channel === 'messenger') {
      return reply.code(400).send({ error: 'Templates are not supported for Messenger yet' });
    }
    if (conv.channel === 'telegram') {
      return reply.code(400).send({ error: 'Telegram has no template system — send a normal message instead' });
    }
    if (!conv.contact?.phone) {
      return reply.code(400).send({ error: 'Contact has no phone number' });
    }

    const template = await prisma.template.findFirst({
      where: { id: templateId, workspaceId },
    });
    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }
    if (template.status !== 'approved') {
      return reply.code(400).send({
        error: 'Only approved templates can be sent. Check status in Templates.',
      });
    }

    const varCount = extractVariableIndexes(template.bodyPattern).length;
    const bodyParams = Array.isArray(variables) ? variables.map((v) => String(v)) : [];
    if (bodyParams.length !== varCount) {
      return reply.code(400).send({
        error: `This template requires ${varCount} variable(s).`,
      });
    }
    if (bodyParams.some((v) => !v.trim())) {
      return reply.code(400).send({ error: 'All template variables must be filled in' });
    }

    let credentials;
    try {
      credentials = await getWorkspaceWhatsAppCredentials(workspaceId, conv.channelAccountId);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'WhatsApp not connected',
      });
    }
    if (!credentials.phoneNumberId) {
      return reply.code(400).send({ error: 'No WhatsApp phone number configured for this workspace' });
    }

    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    const displayContent = renderTemplateBody(template.bodyPattern, bodyParams);

    let headerMedia:
      | {
          format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
          waMediaId: string;
          fileName?: string;
        }
      | undefined;

    if (isTemplateMediaHeaderFormat(template.headerFormat)) {
      try {
        const uploaded =
          headerMediaBuffer && headerMediaBuffer.length > 0
            ? {
                buffer: headerMediaBuffer,
                mimeType: headerMediaMimeType,
                fileName: headerMediaFileName || undefined,
              }
            : null;
        const resolved = await uploadTemplateHeaderMediaForSend(
          credentials.accessToken,
          credentials.phoneNumberId,
          workspaceId,
          template,
          uploaded
        );
        headerMedia = resolved;
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Template header media is required',
        });
      }
    }

    let waMessageId: string | undefined;
    try {
      await assertWhatsAppTemplateAffordable({
        workspaceId,
        templateCategory: template.category,
        phoneNumberId: credentials.phoneNumberId,
      });
      const sent = await sendWhatsAppTemplateMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        conv.contact.phone,
        template.name,
        template.language,
        bodyParams,
        headerMedia ? { headerMedia } : undefined
      );
      waMessageId = sent.waMessageId;
    } catch (err) {
      if (err instanceof InsufficientWalletBalanceError) {
        return reply.code(402).send({ error: err.message, code: err.code });
      }
      request.log.error({ err }, 'WhatsApp template send failed');
      const sendError = formatMetaSendError(err);
      const failed = await persistFailedOutboundMessage({
        workspaceId,
        conversationId: id,
        senderName: agent?.name ?? 'Agent',
        content: displayContent,
        type: 'template',
        metadata: {
          templateId: template.id,
          templateName: template.name,
          variables: bodyParams,
          ...(headerMedia
            ? {
                headerFormat: headerMedia.format,
                headerMediaFileName: headerMedia.fileName ?? null,
              }
            : {}),
        },
        sendError,
      });
      return reply.code(502).send({ error: sendError, message: failed });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        waMessageId,
        sender: 'agent',
        senderName: agent?.name ?? 'Agent',
        content: displayContent,
        type: 'template',
        status: 'sent',
        metadata: {
          templateId: template.id,
          templateName: template.name,
          variables: bodyParams,
          ...(headerMedia
            ? {
                headerFormat: headerMedia.format,
                headerMediaFileName: headerMedia.fileName ?? null,
              }
            : {}),
        },
      },
    });

    try {
      await chargeWhatsAppTemplateUsage({
        workspaceId,
        templateCategory: template.category,
        referenceId: message.id,
        templateName: template.name,
        phoneNumberId: credentials.phoneNumberId,
      });
    } catch (err) {
      request.log.error({ err, messageId: message.id }, 'Wallet debit after template send failed');
    }

    await prisma.conversation.updateMany({
      where: { id, workspaceId },
      data: {
        lastMessage: displayContent,
        lastMessageAt: new Date(),
      },
    });

    getIo().to(workspaceId).emit('new_message', { conversationId: id, message });

    return reply.code(201).send(message);
  });

  fastify.post('/messages/:messageId/resend', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { messageId } = request.params as { messageId: string };
    const access = await resolveMembershipAccess(userId, workspaceId);

    const existing = await prisma.message.findFirst({
      where: { id: messageId },
      include: {
        conversation: {
          select: { workspaceId: true, channel: true, channelAccountId: true },
        },
      },
    });
    if (!existing || existing.conversation.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (!assertConversationInScope(existing.conversation, access.inboxScope, reply)) return;

    try {
      const message = await resendFailedMessage(messageId, workspaceId);
      return message;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 502;
      const code = (err as { code?: string }).code;
      request.log.error({ err, messageId }, 'Message resend failed');
      return reply.code(statusCode).send({
        error: err instanceof Error ? err.message : 'Resend failed',
        ...(code ? { code } : {}),
      });
    }
  });

  fastify.get('/messages/:messageId/attachment', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { messageId } = request.params as { messageId: string };
    const access = await resolveMembershipAccess(userId, workspaceId);

    const message = await prisma.message.findFirst({
      where: { id: messageId },
      include: {
        conversation: {
          select: { workspaceId: true, channel: true, channelAccountId: true },
        },
      },
    });
    if (!message || message.conversation.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (!assertConversationInScope(message.conversation, access.inboxScope, reply)) return;

    const metadata = (message.metadata ?? {}) as MessageMediaMetadata;
    const { index } = request.query as { index?: string };

    // Carousel/album messages hold multiple files under metadata.items — pick
    // one by ?index=N; single-media messages ignore the param.
    const target =
      index !== undefined && metadata.items
        ? metadata.items[Number(index)]
        : { storageKey: metadata.storageKey, fileName: metadata.fileName };

    if (!target?.storageKey) {
      return reply.code(404).send({ error: 'No attachment for this message' });
    }

    try {
      const { buffer, mimeType } = await readMessageMediaFile(target.storageKey);
      const fileName = target.fileName || `attachment-${messageId}`;
      const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return reply
        .header('Content-Type', mimeType)
        .header('Content-Disposition', contentDisposition('inline', fileName))
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'Attachment file not found' });
    }
  });

  fastify.post('/:id/messages/media', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);

    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;
    if (
      conv.channel !== 'whatsapp' &&
      conv.channel !== 'instagram' &&
      conv.channel !== 'messenger' &&
      conv.channel !== 'telegram'
    ) {
      return reply.code(400).send({
        error: 'Media messages are only supported on WhatsApp, Instagram, Messenger, and Telegram',
      });
    }
    if (!conv.contact?.phone) {
      return reply.code(400).send({ error: 'Contact has no phone number' });
    }

    let fileBuffer: Buffer | null = null;
    let mimeType = '';
    let fileName = '';
    let caption = '';

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        mimeType = part.mimetype || 'application/octet-stream';
        fileName = part.filename || 'file';
      } else if (part.type === 'field' && part.fieldname === 'caption') {
        caption = String(part.value ?? '').trim();
      }
    }

    if (!fileBuffer || !fileBuffer.length) {
      return reply.code(400).send({ error: 'File is required' });
    }

    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    let waMessageId: string | undefined;
    let messageKind: string;
    let content: string;
    let initialMetadata: MessageMediaMetadata;
    let channelAccountId: string | undefined;
    let captionSent = false;

    if (conv.channel === 'instagram') {
      const instagramUserId = parseInstagramScopedUserId(conv.contact.phone);
      if (!instagramUserId) {
        return reply.code(400).send({ error: 'Contact has no Instagram user id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceInstagramCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Instagram not connected',
        });
      }

      const igKind = resolveOutboundInstagramKind(mimeType);
      messageKind = igKind === 'file' ? 'document' : igKind;
      content = previewForMessage(messageKind as 'image' | 'video' | 'audio' | 'document', caption || fileName, caption);
      channelAccountId = credentials.pageId;

      try {
        await assertInstagramMessageAffordable(workspaceId);
        const staged = await stageMediaForMetaFetch(fileBuffer, mimeType, fileName);
        const sent = await sendInstagramMediaMessage(
          credentials.pageId,
          credentials.pageAccessToken,
          instagramUserId,
          igKind,
          staged.publicUrl
        );
        waMessageId = sent.messageId;
        initialMetadata = {
          mimeType,
          fileName,
          caption: caption || undefined,
        };

        if (caption.trim()) {
          try {
            await assertInstagramMessageAffordable(workspaceId);
            await sendInstagramMessage(
              credentials.pageId,
              credentials.pageAccessToken,
              instagramUserId,
              caption
            );
            captionSent = true;
          } catch (captionErr) {
            request.log.warn({ err: captionErr }, 'Instagram caption text send failed');
          }
        }
      } catch (err) {
        if (err instanceof InsufficientWalletBalanceError) {
          return reply.code(402).send({ error: err.message, code: err.code });
        }
        request.log.error({ err }, 'Instagram media send failed');
        const sendError =
          err instanceof Error ? err.message : formatInstagramSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content,
          type: messageKind,
          metadata: { mimeType, fileName, caption: caption || undefined },
          sendError,
        });
        try {
          const storageKey = await saveMessageMediaFile(
            workspaceId,
            failed.id,
            fileBuffer,
            mimeType,
            fileName
          );
          const metadata = mergeSendErrorMetadata(
            { mimeType, fileName, caption: caption || undefined, storageKey },
            sendError
          );
          const updated = await prisma.message.update({
            where: { id: failed.id },
            data: { metadata: metadata as object },
          });
          return reply.code(502).send({ error: sendError, message: updated });
        } catch {
          return reply.code(502).send({ error: sendError, message: failed });
        }
      }
    } else if (conv.channel === 'messenger') {
      const psid = parseMessengerPsid(conv.contact.phone);
      if (!psid) {
        return reply.code(400).send({ error: 'Contact has no Messenger user id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceMessengerCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Messenger not connected',
        });
      }

      const metaKind = resolveOutboundInstagramKind(mimeType);
      messageKind = metaKind === 'file' ? 'document' : metaKind;
      content = previewForMessage(
        messageKind as 'image' | 'video' | 'audio' | 'document',
        caption || fileName,
        caption
      );
      channelAccountId = credentials.pageId;

      try {
        const staged = await stageMediaForMetaFetch(fileBuffer, mimeType, fileName);
        const sent = await sendMessengerMediaMessage(
          credentials.pageId,
          credentials.pageAccessToken,
          psid,
          metaKind,
          staged.publicUrl
        );
        waMessageId = sent.messageId;
        initialMetadata = {
          mimeType,
          fileName,
          caption: caption || undefined,
        };

        if (caption.trim()) {
          try {
            await sendMessengerMessage(
              credentials.pageId,
              credentials.pageAccessToken,
              psid,
              caption
            );
            captionSent = true;
          } catch (captionErr) {
            request.log.warn({ err: captionErr }, 'Messenger caption text send failed');
          }
        }
      } catch (err) {
        request.log.error({ err }, 'Messenger media send failed');
        const sendError = formatMessengerSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content,
          type: messageKind,
          metadata: { mimeType, fileName, caption: caption || undefined },
          sendError,
        });
        try {
          const storageKey = await saveMessageMediaFile(
            workspaceId,
            failed.id,
            fileBuffer,
            mimeType,
            fileName
          );
          const metadata = mergeSendErrorMetadata(
            { mimeType, fileName, caption: caption || undefined, storageKey },
            sendError
          );
          const updated = await prisma.message.update({
            where: { id: failed.id },
            data: { metadata: metadata as object },
          });
          return reply.code(502).send({ error: sendError, message: updated });
        } catch {
          return reply.code(502).send({ error: sendError, message: failed });
        }
      }
    } else if (conv.channel === 'telegram') {
      const chatId = parseTelegramChatId(conv.contact.phone);
      if (!chatId) {
        return reply.code(400).send({ error: 'Contact has no Telegram chat id' });
      }

      let credentials;
      try {
        credentials = await getWorkspaceTelegramCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Telegram not connected',
        });
      }

      const tgKind = resolveOutboundWhatsAppKind(mimeType);
      messageKind = tgKind;
      content = previewForMessage(tgKind, caption || fileName, caption);
      channelAccountId = credentials.botId;

      try {
        const sent = await sendTelegramMedia(
          credentials.botToken,
          chatId,
          tgKind,
          fileBuffer,
          mimeType,
          fileName,
          caption || undefined
        );
        waMessageId = sent.messageId;
        initialMetadata = {
          mimeType,
          fileName,
          caption: caption || undefined,
        };
      } catch (err) {
        request.log.error({ err }, 'Telegram media send failed');
        const sendError = formatTelegramSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content,
          type: messageKind,
          metadata: { mimeType, fileName, caption: caption || undefined },
          sendError,
        });
        try {
          const storageKey = await saveMessageMediaFile(
            workspaceId,
            failed.id,
            fileBuffer,
            mimeType,
            fileName
          );
          const metadata = mergeSendErrorMetadata(
            { mimeType, fileName, caption: caption || undefined, storageKey },
            sendError
          );
          const updated = await prisma.message.update({
            where: { id: failed.id },
            data: { metadata: metadata as object },
          });
          return reply.code(502).send({ error: sendError, message: updated });
        } catch {
          return reply.code(502).send({ error: sendError, message: failed });
        }
      }
    } else {
      let credentials;
      try {
        credentials = await getWorkspaceWhatsAppCredentials(workspaceId, conv.channelAccountId);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'WhatsApp not connected',
        });
      }
      if (!credentials.phoneNumberId) {
        return reply.code(400).send({ error: 'No WhatsApp phone number configured for this workspace' });
      }

      const kind = resolveOutboundWhatsAppKind(mimeType);
      messageKind = kind;
      content = previewForMessage(kind, caption || fileName, caption);
      channelAccountId = credentials.phoneNumberId;

      let waMediaId: string;
      try {
        waMediaId = await uploadWhatsAppMedia(
          credentials.accessToken,
          credentials.phoneNumberId,
          fileBuffer,
          mimeType,
          fileName
        );
        const sent = await sendWhatsAppMediaMessage(
          credentials.accessToken,
          credentials.phoneNumberId,
          conv.contact.phone,
          kind,
          waMediaId,
          caption,
          fileName
        );
        waMessageId = sent.waMessageId;
        initialMetadata = {
          mimeType,
          fileName,
          caption: caption || undefined,
          waMediaId,
        };
      } catch (err) {
        request.log.error({ err }, 'WhatsApp media send failed');
        const sendError = formatMetaSendError(err);
        const failed = await persistFailedOutboundMessage({
          workspaceId,
          conversationId: id,
          senderName: agent?.name ?? 'Agent',
          content,
          type: messageKind,
          metadata: { mimeType, fileName, caption: caption || undefined },
          sendError,
        });
        try {
          const storageKey = await saveMessageMediaFile(
            workspaceId,
            failed.id,
            fileBuffer,
            mimeType,
            fileName
          );
          const metadata = mergeSendErrorMetadata(
            { mimeType, fileName, caption: caption || undefined, storageKey },
            sendError
          );
          const updated = await prisma.message.update({
            where: { id: failed.id },
            data: { metadata: metadata as object },
          });
          return reply.code(502).send({ error: sendError, message: updated });
        } catch {
          return reply.code(502).send({ error: sendError, message: failed });
        }
      }
    }

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        waMessageId,
        sender: 'agent',
        senderName: agent?.name ?? 'Agent',
        content,
        type: messageKind,
        status: 'sent',
        metadata: initialMetadata as object,
      },
    });

    if (conv.channel === 'instagram') {
      try {
        await chargeInstagramMessageUsage({
          workspaceId,
          referenceId: message.id,
        });
        if (captionSent) {
          await chargeInstagramMessageUsage({
            workspaceId,
            referenceId: `${message.id}:caption`,
          });
        }
      } catch (err) {
        request.log.error({ err }, 'Instagram wallet debit failed');
      }
    }

    try {
      const storageKey = await saveMessageMediaFile(
        workspaceId,
        message.id,
        fileBuffer,
        mimeType,
        fileName
      );
      const metadata: MessageMediaMetadata = {
        ...initialMetadata,
        storageKey,
      };
      await prisma.message.update({
        where: { id: message.id },
        data: { metadata: metadata as object },
      });
      message.metadata = metadata as object;
    } catch (err) {
      request.log.error({ err }, 'Failed to persist outbound media file');
    }

    await prisma.conversation.updateMany({
      where: { id, workspaceId },
      data: {
        lastMessage: content,
        lastMessageAt: new Date(),
        channelAccountId,
      },
    });

    getIo().to(workspaceId).emit('new_message', { conversationId: id, message });
    return reply.code(201).send(message);
  });

  /** Telegram-only album/carousel — sendMediaGroup. 2-10 photos/videos, one shared caption. */
  fastify.post('/:id/messages/carousel', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);

    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;
    if (conv.channel !== 'telegram') {
      return reply.code(400).send({ error: 'Albums are only supported on Telegram' });
    }

    const chatId = parseTelegramChatId(conv.contact?.phone || '');
    if (!chatId) {
      return reply.code(400).send({ error: 'Contact has no Telegram chat id' });
    }

    let credentials;
    try {
      credentials = await getWorkspaceTelegramCredentials(workspaceId, conv.channelAccountId);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Telegram not connected',
      });
    }

    const files: { buffer: Buffer; mimeType: string; fileName: string }[] = [];
    let caption = '';

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        files.push({
          buffer,
          mimeType: part.mimetype || 'application/octet-stream',
          fileName: part.filename || `file-${files.length}`,
        });
      } else if (part.type === 'field' && part.fieldname === 'caption') {
        caption = String(part.value ?? '').trim();
      }
    }

    if (files.length < 2 || files.length > 10) {
      return reply.code(400).send({ error: 'Pick between 2 and 10 files for an album.' });
    }

    const items = files.map((file) => {
      const kind = resolveOutboundWhatsAppKind(file.mimeType);
      return { ...file, kind };
    });
    const badFile = items.find((item) => item.kind !== 'image' && item.kind !== 'video');
    if (badFile) {
      return reply.code(400).send({
        error: `${badFile.fileName} isn't a photo or video — Telegram albums only support photos and videos.`,
      });
    }

    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    let sent;
    try {
      sent = await sendTelegramMediaGroup(
        credentials.botToken,
        chatId,
        items as Array<{ buffer: Buffer; mimeType: string; fileName: string; kind: 'image' | 'video' }>,
        caption || undefined
      );
    } catch (err) {
      request.log.error({ err }, 'Telegram album send failed');
      return reply.code(502).send({ error: formatTelegramSendError(err) });
    }

    const content = caption || `📷 Album (${files.length} items)`;
    const message = await prisma.message.create({
      data: {
        conversationId: id,
        waMessageId: sent.messageIds[0],
        sender: 'agent',
        senderName: agent?.name ?? 'Agent',
        content,
        type: 'carousel',
        status: 'sent',
        metadata: { caption: caption || undefined, telegramMessageIds: sent.messageIds } as object,
      },
    });

    const storedItems: Array<{ storageKey: string; mimeType: string; fileName: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const storageKey = await saveMessageMediaFile(
          workspaceId,
          `${message.id}-${i}`,
          file.buffer,
          file.mimeType,
          file.fileName
        );
        storedItems.push({ storageKey, mimeType: file.mimeType, fileName: file.fileName });
      } catch (err) {
        request.log.error({ err }, 'Failed to persist album item');
      }
    }

    const metadata: MessageMediaMetadata = {
      caption: caption || undefined,
      telegramMessageIds: sent.messageIds,
      items: storedItems,
    };
    await prisma.message.update({
      where: { id: message.id },
      data: { metadata: metadata as object },
    });
    message.metadata = metadata as object;

    await prisma.conversation.updateMany({
      where: { id, workspaceId },
      data: { lastMessage: content, lastMessageAt: new Date(), channelAccountId: credentials.botId },
    });

    getIo().to(workspaceId).emit('new_message', { conversationId: id, message });
    return reply.code(201).send(message);
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      select: { channel: true, channelAccountId: true },
    });
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(conv, access.inboxScope, reply)) return;

    const deleted = await deleteConversationThread(workspaceId, id);
    if (!deleted) {
      return reply.code(404).send({ error: 'Not found' });
    }

    getIo().to(workspaceId).emit('conversation_deleted', { conversationId: id });
    return { success: true };
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const access = await resolveMembershipAccess(userId, workspaceId);
    const existing = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      select: { channel: true, channelAccountId: true, status: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    if (!assertConversationInScope(existing, access.inboxScope, reply)) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const data = scopedUpdateData(body);

    const hasAssigneePatch =
      'assigneeType' in body ||
      'assigneeId' in body ||
      (typeof body.assignedTo === 'string' && body.assignedTo);

    if (hasAssigneePatch) {
      let assigneeType: ConversationAssigneeType | null | undefined;
      let assigneeId: string | null | undefined;

      if ('assigneeType' in body) {
        const raw = body.assigneeType;
        if (raw === null || raw === '') {
          assigneeType = null;
          assigneeId = null;
        } else if (typeof raw === 'string' && isConversationAssigneeType(raw)) {
          assigneeType = raw;
          assigneeId =
            typeof body.assigneeId === 'string' && body.assigneeId ? body.assigneeId : null;
        } else {
          return reply.code(400).send({ error: 'Invalid assignee type' });
        }
      } else if (typeof body.assignedTo === 'string' && body.assignedTo) {
        assigneeType = 'user';
        assigneeId = body.assignedTo;
      }

      const actorUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      try {
        await applyConversationAssignee(
          workspaceId,
          id,
          {
            assigneeType: assigneeType ?? null,
            assigneeId: assigneeId ?? null,
          },
          {
            actorType: 'HUMAN',
            actorId: userId,
            actorName: actorUser?.name?.trim() || null,
          }
        );
      } catch (err) {
        if (err instanceof ConversationAssigneeError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      delete data.assigneeType;
      delete data.assigneeId;
      delete data.assignedTo;
    } else if (typeof data.assignedTo === 'string' && data.assignedTo) {
      const ok = await isWorkspaceMember(workspaceId, data.assignedTo);
      if (!ok) return reply.code(400).send({ error: 'Agent must belong to this company' });
    }

    if (data.status === 'resolved') {
      await onConversationResolved(id);
    } else if (
      typeof data.status === 'string' &&
      data.status !== 'resolved' &&
      existing.status === 'resolved'
    ) {
      await recordConversationEvent({
        conversationId: id,
        workspaceId,
        type: 'CONVERSATION_REOPENED',
        actorType: 'HUMAN',
        actorId: userId,
      });
    }

    if (Object.keys(data).length > 0) {
      await prisma.conversation.updateMany({
        where: { id, workspaceId },
        data,
      });
    }

    getIo().to(workspaceId).emit('conversation_updated', { conversationId: id });

    return prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, agent: true },
    });
  });
}
