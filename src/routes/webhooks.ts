import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { config } from '../config.js';
import { resolveWorkspaceByPhoneNumberId } from '../services/workspaceResolve.js';
import {
  handleMetaMessagingWebhook,
} from '../services/metaMessagingWebhook.js';
import {
  logInstagramWebhook,
  type PageMessagingWebhookBody,
} from '../services/instagramWebhookHandler.js';
import { routeInboundWhatsApp } from '../services/conversation-inbound-router.service.js';
import { findOrReopenConversationForInbound } from '../services/conversationThread.service.js';
import { eventBus } from '../modules/journey/events/event-bus.js';
import { handleResendEmailWebhook } from '../modules/email/services/resend-webhook.service.js';
import {
  extractWhatsAppProfileName,
  upsertWhatsAppContact,
  type WhatsAppWebhookContact,
} from '../lib/whatsappContact.js';
import {
  handleCoexistenceHistoryWebhook,
  handleSmbAppStateSync,
  handleSmbMessageEchoes,
} from '../services/whatsappCoexistenceWebhook.js';
import {
  fetchAndStoreInboundMedia,
  parseInboundWhatsAppMessage,
  previewForMessage,
  type MessageMediaMetadata,
} from '../services/whatsappMedia.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';

function logWebhook(label: string, payload: unknown) {
  const line = `[WhatsApp Webhook] ${label}`;
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

export default async function webhookRoutes(fastify: FastifyInstance) {
  fastify.get('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    logWebhook('GET verify', { mode, tokenMatch: token === config.meta.webhookVerifyToken, challenge });

    if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
      logWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] POST hit — incoming event', new Date().toISOString());
    const body = request.body as {
      object?: string;
      entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }>;
    };

    // Meta Page / Instagram webhooks sometimes hit the WhatsApp callback URL by misconfig.
    if (body?.object === 'page' || body?.object === 'instagram') {
      logWebhook('POST → forwarding Page/Instagram payload to Meta messaging handler', {
        object: body.object,
      });
      try {
        await handleMetaMessagingWebhook(body as PageMessagingWebhookBody);
      } catch (err) {
        logWebhook('POST → Meta messaging forward error', err instanceof Error ? err.message : err);
        fastify.log.error(err);
      }
      logWebhook('POST → response', 'ok');
      return reply.send('ok');
    }

    logWebhook('POST payload', body);

    try {
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const field = changes?.field;
      const value = changes?.value as {
        contacts?: WhatsAppWebhookContact[];
        messages?: Array<Record<string, unknown> & { id: string; from: string }>;
        message_echoes?: Array<Record<string, unknown> & { id: string; to: string }>;
        statuses?: Array<{ id: string; status: string }>;
        metadata?: { phone_number_id?: string };
        state_sync?: Array<Record<string, unknown>>;
        history?: Array<Record<string, unknown>>;
        errors?: Array<{ code?: number; message?: string }>;
      };

      if (field === 'smb_message_echoes') {
        await handleSmbMessageEchoes(value);
        logWebhook('POST → response', 'ok');
        return reply.send('ok');
      }

      if (field === 'smb_app_state_sync') {
        await handleSmbAppStateSync(value);
        logWebhook('POST → response', 'ok');
        return reply.send('ok');
      }

      if (field === 'history') {
        await handleCoexistenceHistoryWebhook(value);
        logWebhook('POST → response', 'ok');
        return reply.send('ok');
      }

      if (value?.messages?.[0]) {
        const msg = value.messages[0];
        const from = msg.from;
        const parsed = parseInboundWhatsAppMessage(msg);
        const text = parsed.content;
        const buttonPayload = parsed.buttonPayload;
        const waNumberId = value.metadata?.phone_number_id;
        if (!waNumberId) {
          logWebhook('POST → skip (no phone_number_id)', value?.metadata);
          logWebhook('POST → response', 'ok');
          return reply.send('ok');
        }

        const workspace = await resolveWorkspaceByPhoneNumberId(waNumberId);
        if (!workspace) {
          logWebhook('POST → skip (unknown workspace)', { waNumberId });
          logWebhook('POST → response', 'ok');
          return reply.send('ok');
        }

        logWebhook('POST → inbound message', { from, text, waNumberId, workspaceId: workspace.id });

        const profileName = extractWhatsAppProfileName(value.contacts, from);
        const contact = await upsertWhatsAppContact({
          db: prisma,
          workspaceId: workspace.id,
          waFrom: from,
          profileName,
        });

        const { conversation: conv, reopened } = await findOrReopenConversationForInbound({
          workspaceId: workspace.id,
          contactId: contact.id,
          channel: 'whatsapp',
          channelAccountId: waNumberId,
        });

        if (reopened) {
          logWebhook('POST → reopened resolved conversation', { conversationId: conv.id });
        }

        const existingMessage = await prisma.message.findFirst({
          where: { waMessageId: msg.id },
        });
        if (existingMessage) {
          logWebhook('POST → duplicate message skipped', { waMessageId: msg.id });
        } else {
          let metadata: MessageMediaMetadata | undefined;
          if (parsed.location) {
            metadata = { ...parsed.location };
          } else if (parsed.media) {
            metadata = {
              mimeType: parsed.media.mimeType,
              fileName: parsed.media.fileName,
              caption: parsed.media.caption,
              waMediaId: parsed.media.waMediaId,
              mediaUrl: parsed.media.mediaUrl,
            };
          }

          const message = await prisma.message.create({
            data: {
              waMessageId: msg.id,
              conversationId: conv.id,
              sender: 'contact',
              senderName: contact.name,
              content: text,
              type: parsed.kind,
              metadata: metadata ? (metadata as object) : undefined,
            },
          });

          if (parsed.media?.waMediaId || parsed.media?.mediaUrl) {
            try {
              const credentials = await getWorkspaceWhatsAppCredentials(workspace.id, waNumberId);
              metadata = await fetchAndStoreInboundMedia({
                workspaceId: workspace.id,
                messageId: message.id,
                waToken: credentials.accessToken,
                media: parsed.media,
              });
              await prisma.message.update({
                where: { id: message.id },
                data: { metadata: metadata as object },
              });
              message.metadata = metadata as object;
            } catch (mediaErr) {
              logWebhook(
                'POST → media download failed',
                mediaErr instanceof Error ? mediaErr.message : mediaErr
              );
            }
          }

          const lastPreview = previewForMessage(parsed.kind, text, parsed.media?.caption);

          await prisma.conversation.updateMany({
            where: { id: conv.id, workspaceId: workspace.id },
            data: {
              lastMessage: lastPreview,
              lastMessageAt: new Date(),
              unreadCount: { increment: 1 },
            },
          });

          getIo().to(workspace.id).emit('new_message', { conversationId: conv.id, message });
          getIo().to(workspace.id).emit('conversation_updated', { conversationId: conv.id });

          logWebhook('POST → saved message', {
            messageId: message.id,
            conversationId: conv.id,
            contactId: contact.id,
          });

          try {
            await routeInboundWhatsApp({
              workspaceId: workspace.id,
              conversationId: conv.id,
              contactId: contact.id,
              contactPhone: contact.phone,
              text,
              buttonPayload,
              phoneNumberId: waNumberId,
            });
          } catch (flowErr) {
            logWebhook('POST → inbound router error', flowErr instanceof Error ? flowErr.message : flowErr);
            fastify.log.error(flowErr);
          }

          void eventBus.emit('message.received', {
            workspaceId: workspace.id,
            event: 'message.received',
            contactId: contact.id,
            payload: { text, conversationId: conv.id },
          });
        }
      }

      if (value?.statuses?.[0]) {
        const statusUpdate = value.statuses[0];
        logWebhook('POST → status update', statusUpdate);
        const message = await prisma.message.findFirst({
          where: { waMessageId: statusUpdate.id },
          include: { conversation: true },
        });
        if (message?.conversation?.workspaceId) {
          await prisma.message.update({
            where: { id: message.id },
            data: { status: statusUpdate.status },
          });
          getIo().to(message.conversation.workspaceId).emit('message_status', {
            messageId: message.id,
            status: statusUpdate.status,
          });
          logWebhook('POST → status applied', { messageId: message.id, status: statusUpdate.status });
        } else {
          logWebhook('POST → status (no local message)', statusUpdate);
        }
      }

      if (!value?.messages?.[0] && !value?.statuses?.[0]) {
        logWebhook('POST → no messages/statuses in payload', {
          field: changes?.field,
          keys: value ? Object.keys(value) : [],
        });
      }
    } catch (err) {
      logWebhook('POST → error', err instanceof Error ? err.message : err);
      fastify.log.error(err);
    }

    logWebhook('POST → response', 'ok');
    return reply.send('ok');
  });

  fastify.get('/instagram', async (request, reply) => {
    console.log('[Instagram Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    logInstagramWebhook('GET verify', {
      mode,
      tokenMatch: token === config.meta.webhookVerifyToken,
      challenge,
    });

    if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
      logInstagramWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logInstagramWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/instagram', async (request, reply) => {
    console.log('[Instagram Webhook] POST hit — incoming event', new Date().toISOString());
    const body = request.body as PageMessagingWebhookBody;
    console.log('[Instagram Webhook] payload', JSON.stringify(body, null, 2));

    logInstagramWebhook('POST payload', body);

    try {
      await handleMetaMessagingWebhook(body);
    } catch (err) {
      logInstagramWebhook('POST → error', err instanceof Error ? err.message : err);
      fastify.log.error(err);
    }

    logInstagramWebhook('POST → response', 'ok');
    return reply.send('ok');
  });

  await fastify.register(async function resendEmailWebhookScope(instance) {
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    instance.post('/resend', async (request, reply) => {
      const payload = request.body as string;
      const headers = request.headers;

      try {
        const result = await handleResendEmailWebhook(payload, {
          svixId: headers['svix-id'] as string | undefined,
          svixTimestamp: headers['svix-timestamp'] as string | undefined,
          svixSignature: headers['svix-signature'] as string | undefined,
        });
        if (result.updated) {
          fastify.log.info({ eventType: result.eventType }, 'Resend email log updated');
        }
        return reply.send({ ok: true });
      } catch (err) {
        fastify.log.warn({ err }, 'Resend webhook rejected');
        return reply.code(400).send({ error: 'Invalid webhook' });
      }
    });
  });
}
