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
  isConversationAssigneeType,
  type ConversationAssigneeType,
} from '../types/conversation-assignee.js';
import {
  isInstagramPhone,
  isInstagramSource,
  isMessengerPhone,
  isMessengerSource,
  parseInstagramScopedUserId,
  parseMessengerPsid,
} from '../lib/channelContact.js';
import { getWorkspaceInstagramCredentials } from '../services/instagramCredentials.js';
import { formatInstagramSendError, sendInstagramMessage } from '../services/instagram.js';
import { refreshInstagramContactProfile } from '../services/instagramContactProfile.js';
import { getWorkspaceMessengerCredentials } from '../services/messengerCredentials.js';
import { formatMessengerSendError, sendMessengerMessage } from '../services/messenger.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import { extractVariableIndexes } from '../services/metaMessageTemplates.js';
import { deleteConversationThread } from '../services/conversation-delete.service.js';
import {
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
  resolveOutboundInstagramKind,
  sendInstagramMediaMessage,
} from '../services/instagramMedia.js';
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
import { resolveMembershipAccess } from '../services/workspaceMemberAdmin.js';
import {
  buildConversationScopeWhere,
  conversationMatchesInboxScope,
  type InboxScope,
} from '../services/inboxScope.js';

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
    return prisma.conversation.findMany({
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
    const { contactId } = request.body as { contactId?: string };

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

    const channelAccountId =
      channel === 'instagram'
        ? (
            await prisma.instagramAccount.findFirst({
              where: { workspaceId },
              orderBy: { createdAt: 'desc' },
            })
          )?.pageId
        : channel === 'messenger'
          ? (
              await prisma.messengerAccount.findFirst({
                where: { workspaceId },
                orderBy: { createdAt: 'desc' },
              })
            )?.pageId
          : (
              await prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { waNumberId: true },
              })
            )?.waNumberId;

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

  fastify.get('/:id/messages', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };
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

    return prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
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
        const sent = await sendInstagramMessage(
          credentials.pageId,
          credentials.pageAccessToken,
          instagramUserId,
          text
        );
        messageId = sent.messageId;
      } catch (err) {
        request.log.error({ err }, 'Instagram send failed');
        return reply.code(502).send({
          error: formatInstagramSendError(err),
        });
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
        return reply.code(502).send({
          error: formatMessengerSendError(err),
        });
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
      return reply.code(502).send({
        error: formatMetaSendError(err),
      });
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
    const { templateId, variables } = request.body as {
      templateId?: string;
      variables?: string[];
    };

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

    let waMessageId: string | undefined;
    try {
      const sent = await sendWhatsAppTemplateMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        conv.contact.phone,
        template.name,
        template.language,
        bodyParams
      );
      waMessageId = sent.waMessageId;
    } catch (err) {
      request.log.error({ err }, 'WhatsApp template send failed');
      return reply.code(502).send({ error: formatMetaSendError(err) });
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
        },
      },
    });

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
    if (!metadata.storageKey) {
      return reply.code(404).send({ error: 'No attachment for this message' });
    }

    try {
      const { buffer, mimeType } = await readMessageMediaFile(metadata.storageKey);
      const fileName = metadata.fileName || `attachment-${messageId}`;
      return reply
        .header('Content-Type', mimeType)
        .header('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`)
        .send(buffer);
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
    if (conv.channel !== 'whatsapp' && conv.channel !== 'instagram') {
      return reply.code(400).send({ error: 'Media messages are only supported on WhatsApp and Instagram' });
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
            await sendInstagramMessage(
              credentials.pageId,
              credentials.pageAccessToken,
              instagramUserId,
              caption
            );
          } catch (captionErr) {
            request.log.warn({ err: captionErr }, 'Instagram caption text send failed');
          }
        }
      } catch (err) {
        request.log.error({ err }, 'Instagram media send failed');
        const message =
          err instanceof Error ? err.message : formatInstagramSendError(err);
        return reply.code(502).send({ error: message });
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
        return reply.code(502).send({
          error: formatMetaSendError(err),
        });
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
      select: { channel: true, channelAccountId: true },
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

      try {
        await applyConversationAssignee(workspaceId, id, {
          assigneeType: assigneeType ?? null,
          assigneeId: assigneeId ?? null,
        });
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
