import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { config } from '../config.js';
import {
  resolveWorkspaceByPhoneNumberId,
  resolveWorkspaceByWabaId,
} from '../services/workspaceResolve.js';
import {
  handleMetaMessagingWebhook,
} from '../services/metaMessagingWebhook.js';
import {
  logInstagramWebhook,
  type PageMessagingWebhookBody,
} from '../services/instagramWebhookHandler.js';
import { routeInboundWhatsApp } from '../services/conversation-inbound-router.service.js';
import { findOrReopenConversationForInbound } from '../services/conversationThread.service.js';
import { handleResendEmailWebhook } from '../modules/email/services/resend-webhook.service.js';
import { handleSesEmailWebhook } from '../modules/email/services/ses-webhook.service.js';
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
  isSkippedInbound,
  parseInboundWhatsAppMessage,
  previewForMessage,
  type MessageMediaMetadata,
} from '../services/whatsappMedia.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import { isOptOutMessage, markContactUnsubscribed } from '../services/contactOptOut.service.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import {
  mergeWhatsAppStatusMetadata,
  normalizeWhatsAppStatusErrors,
  type WhatsAppStatusUpdate,
} from '../lib/whatsappStatusErrors.js';
import { recordInboundMetaWebhook } from '../services/webhookEventLog.service.js';
import { safeStringEquals, verifyMetaWebhookSignature } from '../utils/crypto.utils.js';
import {
  handleTelegramUpdate,
  type TelegramUpdate,
} from '../services/telegramWebhookHandler.js';

function logWebhook(label: string, payload: unknown) {
  const line = `[WhatsApp Webhook] ${label}`;
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export default async function webhookRoutes(fastify: FastifyInstance) {
  // Capture the exact bytes Meta sent (before JSON parsing) so the POST
  // handlers below can verify X-Hub-Signature-256 against them — HMAC only
  // matches over the raw body, not a re-serialized copy of the parsed object.
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.includes('/whatsapp') && !request.url.includes('/instagram')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    (request as RawBodyRequest).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });

  function verifyMetaSignature(request: FastifyRequest): boolean {
    if (!config.meta.appSecret) {
      if (process.env.NODE_ENV === 'production') return false;
      console.warn('[Webhook] META_APP_SECRET unset — accepting unverified payload in dev');
      return true;
    }
    const rawBody = (request as RawBodyRequest).rawBody;
    if (!rawBody) return false;
    const signature = request.headers['x-hub-signature-256'];
    return verifyMetaWebhookSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      config.meta.appSecret
    );
  }

  fastify.get('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const tokenMatch = safeStringEquals(token, config.meta.webhookVerifyToken);
    logWebhook('GET verify', { mode, tokenMatch, challenge });

    if (mode === 'subscribe' && tokenMatch) {
      logWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] POST hit — incoming event', new Date().toISOString());
    if (!verifyMetaSignature(request)) {
      logWebhook('POST → rejected', 'invalid or missing X-Hub-Signature-256');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const body = request.body as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
      }>;
    };

    // One row per delivery (incl. ignored fields like message_template_status_update).
    let processError: string | null = null;
    try {
    // Meta Page / Instagram webhooks sometimes hit the WhatsApp callback URL by misconfig.
    if (body?.object === 'page' || body?.object === 'instagram') {
      logWebhook('POST → forwarding Page/Instagram payload to Meta messaging handler', {
        object: body.object,
      });
      try {
        await handleMetaMessagingWebhook(body as PageMessagingWebhookBody);
      } catch (err) {
        processError = err instanceof Error ? err.message : String(err);
        logWebhook('POST → Meta messaging forward error', processError);
        fastify.log.error(err);
      }
      logWebhook('POST → response', 'ok');
      return reply.send('ok');
    }

    logWebhook('POST payload', body);

      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const field = changes?.field;
      const value = changes?.value as {
        contacts?: WhatsAppWebhookContact[];
        messages?: Array<Record<string, unknown> & { id: string; from: string }>;
        message_echoes?: Array<Record<string, unknown> & { id: string; to: string }>;
        statuses?: WhatsAppStatusUpdate[];
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
        const waNumberId = value.metadata?.phone_number_id;

        if (isSkippedInbound(parsed)) {
          // Meta still needs 200 OK — we just don't create a Message row.
          logWebhook('POST → skipped message (no persist)', {
            from,
            type: msg.type,
            waMessageId: msg.id,
          });
        } else if (!waNumberId) {
          logWebhook('POST → skip (no phone_number_id)', value?.metadata);
        } else {
          const text = parsed.content;
          const buttonPayload = parsed.buttonPayload;
          const workspace = await resolveWorkspaceByPhoneNumberId(waNumberId);
          if (!workspace) {
            logWebhook('POST → skip (unknown workspace)', { waNumberId });
          } else {
            logWebhook('POST → inbound message', {
              from,
              text,
              waNumberId,
              workspaceId: workspace.id,
            });

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
              } else if (parsed.flowResponse) {
                metadata = { ...parsed.flowResponse } as unknown as MessageMediaMetadata;
              } else if (parsed.media) {
                metadata = {
                  mimeType: parsed.media.mimeType,
                  fileName: parsed.media.fileName,
                  caption: parsed.media.caption,
                  waMediaId: parsed.media.waMediaId,
                  mediaUrl: parsed.media.mediaUrl,
                };
              }

              let displayContent = text;
              if (parsed.reaction?.reactedToWaMessageId) {
                const reactedTo = await prisma.message.findFirst({
                  where: {
                    waMessageId: parsed.reaction.reactedToWaMessageId,
                    conversationId: conv.id,
                  },
                  select: { content: true },
                });
                if (reactedTo?.content) {
                  const snippet = reactedTo.content.slice(0, 60);
                  displayContent = `${parsed.reaction.emoji || '👍'} reacted to: ${snippet}`;
                }
              }

              const message = await prisma.message.create({
                data: {
                  waMessageId: msg.id,
                  conversationId: conv.id,
                  sender: parsed.sender === 'system' ? 'system' : 'contact',
                  senderName: parsed.sender === 'system' ? 'WhatsApp' : contact.name,
                  content: displayContent,
                  type: parsed.kind,
                  metadata: metadata ? (metadata as object) : undefined,
                },
              });

              if (parsed.media?.waMediaId || parsed.media?.mediaUrl) {
                try {
                  const credentials = await getWorkspaceWhatsAppCredentials(
                    workspace.id,
                    waNumberId
                  );
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

              const lastPreview = previewForMessage(
                parsed.kind,
                displayContent,
                parsed.media?.caption
              );

              await prisma.conversation.updateMany({
                where: { id: conv.id, workspaceId: workspace.id },
                data: {
                  lastMessage: lastPreview,
                  lastMessageAt: new Date(),
                  unreadCount: { increment: 1 },
                },
              });

              getIo().to(workspace.id).emit('new_message', {
                conversationId: conv.id,
                message,
              });
              getIo().to(workspace.id).emit('conversation_updated', {
                conversationId: conv.id,
              });

              logWebhook('POST → saved message', {
                messageId: message.id,
                conversationId: conv.id,
                contactId: contact.id,
              });

              // Opt-out works regardless of whatever automation (if any) is
              // currently assigned to this conversation — a business relying
              // solely on a rule-based flow's "Unsubscribe" node would miss
              // every contact not currently inside that flow.
              if (parsed.sender !== 'system' && !parsed.reaction && isOptOutMessage(displayContent)) {
                try {
                  const tagged = await markContactUnsubscribed(contact.id, workspace.id);
                  if (tagged) {
                    const credentials = await getWorkspaceWhatsAppCredentials(
                      workspace.id,
                      waNumberId
                    );
                    if (credentials.accessToken && credentials.phoneNumberId) {
                      await sendWhatsAppMessage(
                        credentials.accessToken,
                        credentials.phoneNumberId,
                        contact.phone,
                        "You've been unsubscribed and won't receive further campaign messages."
                      );
                    }
                  }
                } catch (optOutErr) {
                  logWebhook(
                    'POST → opt-out handling error',
                    optOutErr instanceof Error ? optOutErr.message : optOutErr
                  );
                }
              }

              // Don't feed system/reaction noise into journeys / AI.
              if (parsed.sender !== 'system' && !parsed.reaction) {
                try {
                  await routeInboundWhatsApp({
                    workspaceId: workspace.id,
                    conversationId: conv.id,
                    contactId: contact.id,
                    contactPhone: contact.phone,
                    text: displayContent,
                    buttonPayload,
                    flowResponseName: parsed.flowResponse?.flowName,
                    flowResponseFields: parsed.flowResponse?.fields,
                    phoneNumberId: waNumberId,
                    messageId: message.id,
                  });
                } catch (flowErr) {
                  logWebhook(
                    'POST → inbound router error',
                    flowErr instanceof Error ? flowErr.message : flowErr
                  );
                  fastify.log.error(flowErr);
                }
                // Journey trigger emit lives in routeInboundConversation (journey assignee).
              }
            }
          }
        }
        // Always fall through — statuses may share the same webhook delivery.
      }

      if (value?.statuses?.[0]) {
        const statusUpdate = value.statuses[0];
        const statusErrors = normalizeWhatsAppStatusErrors(statusUpdate.errors);
        logWebhook('POST → status update', {
          id: statusUpdate.id,
          status: statusUpdate.status,
          timestamp: statusUpdate.timestamp,
          recipient_id: statusUpdate.recipient_id,
          errors: statusErrors,
        });
        const message = await prisma.message.findFirst({
          where: { waMessageId: statusUpdate.id },
          include: { conversation: true },
        });
        if (message?.conversation?.workspaceId) {
          const metadata = mergeWhatsAppStatusMetadata(message.metadata, statusUpdate);
          await prisma.message.update({
            where: { id: message.id },
            data: {
              status: statusUpdate.status,
              metadata: metadata as object,
            },
          });
          getIo().to(message.conversation.workspaceId).emit('message_status', {
            messageId: message.id,
            status: statusUpdate.status,
            ...(statusErrors.length ? { errors: statusErrors } : {}),
          });
          logWebhook('POST → status applied', {
            messageId: message.id,
            status: statusUpdate.status,
            errorCount: statusErrors.length,
            errorCode: statusErrors[0]?.code,
          });
        } else {
          logWebhook('POST → status (no local message)', {
            id: statusUpdate.id,
            status: statusUpdate.status,
            errors: statusErrors,
          });
        }
      }

      // Subscribed field; raw event is persisted to WebhookEventLog (finally).
      if (field === 'message_template_status_update') {
        logWebhook('POST → message_template_status_update', value);
        const statusValue = value as {
          event?: string;
          message_template_id?: number | string;
          message_template_name?: string;
          message_template_language?: string;
          reason?: string;
        };
        const entryId = typeof entry?.id === 'string' ? entry.id : '';
        const event = String(statusValue.event ?? '').toUpperCase();
        const templateName = String(statusValue.message_template_name ?? '').trim();
        if (entryId && templateName && (event === 'APPROVED' || event === 'REJECTED')) {
          try {
            const workspace = await resolveWorkspaceByWabaId(entryId);
            if (workspace) {
              const { metaStatusToSystem } = await import('../constants/templateLabels.js');
              const status = metaStatusToSystem(event);
              const updated = await prisma.template.updateMany({
                where: { workspaceId: workspace.id, name: templateName },
                data: {
                  status,
                  rejectionReason:
                    event === 'REJECTED' ? String(statusValue.reason ?? 'Rejected by Meta') : null,
                  ...(statusValue.message_template_id
                    ? { waTemplateId: String(statusValue.message_template_id) }
                    : {}),
                },
              });
              if (updated.count > 0) {
                const { emitNotification } = await import(
                  '../services/notifications/emitNotification.js'
                );
                const { NOTIFICATION_TYPES } = await import(
                  '../services/notifications/types.js'
                );
                const tpl = await prisma.template.findFirst({
                  where: { workspaceId: workspace.id, name: templateName },
                  select: { id: true, name: true },
                });
                await emitNotification({
                  workspaceId: workspace.id,
                  type:
                    event === 'APPROVED'
                      ? NOTIFICATION_TYPES.TEMPLATE_APPROVED
                      : NOTIFICATION_TYPES.TEMPLATE_REJECTED,
                  title:
                    event === 'APPROVED' ? 'Template approved' : 'Template rejected',
                  message:
                    event === 'APPROVED'
                      ? `${templateName} was approved by Meta.`
                      : `${templateName} was rejected by Meta.`,
                  entityType: 'template',
                  entityId: tpl?.id ?? null,
                  metadata: {
                    event,
                    language: statusValue.message_template_language,
                    reason: statusValue.reason,
                  },
                });
              }
            }
          } catch (err) {
            logWebhook('POST → template status notify failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (!value?.messages?.[0] && !value?.statuses?.[0]) {
        logWebhook('POST → no messages/statuses in payload', {
          field: changes?.field,
          keys: value ? Object.keys(value) : [],
        });
      }
    } catch (err) {
      processError = err instanceof Error ? err.message : String(err);
      logWebhook('POST → error', processError);
      fastify.log.error(err);
    } finally {
      await recordInboundMetaWebhook(body, { error: processError });
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

    const tokenMatch = safeStringEquals(token, config.meta.webhookVerifyToken);
    logInstagramWebhook('GET verify', { mode, tokenMatch, challenge });

    if (mode === 'subscribe' && tokenMatch) {
      logInstagramWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logInstagramWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/instagram', async (request, reply) => {
    console.log('[Instagram Webhook] POST hit — incoming event', new Date().toISOString());
    if (!verifyMetaSignature(request)) {
      logInstagramWebhook('POST → rejected', 'invalid or missing X-Hub-Signature-256');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const body = request.body as PageMessagingWebhookBody;
    console.log('[Instagram Webhook] payload', JSON.stringify(body, null, 2));

    logInstagramWebhook('POST payload', body);

    let processError: string | null = null;
    try {
      await handleMetaMessagingWebhook(body);
    } catch (err) {
      processError = err instanceof Error ? err.message : String(err);
      logInstagramWebhook('POST → error', processError);
      fastify.log.error(err);
    } finally {
      await recordInboundMetaWebhook(body, { error: processError });
    }

    logInstagramWebhook('POST → response', 'ok');
    return reply.send('ok');
  });

  fastify.post('/telegram/:botId', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const secretHeaderRaw = request.headers['x-telegram-bot-api-secret-token'];
    const secretHeader = Array.isArray(secretHeaderRaw) ? secretHeaderRaw[0] : secretHeaderRaw;

    const account = await prisma.telegramAccount.findFirst({ where: { botId } });
    if (!account) {
      console.log('[Telegram Webhook] unknown bot', botId);
      return reply.code(404).send({ error: 'Unknown bot' });
    }
    if (!account.webhookSecret || !safeStringEquals(secretHeader, account.webhookSecret)) {
      console.log('[Telegram Webhook] rejected — bad secret token', { botId });
      return reply.code(401).send({ error: 'Invalid secret token' });
    }

    const body = request.body as TelegramUpdate;
    try {
      await handleTelegramUpdate(botId, body);
    } catch (err) {
      console.error('[Telegram Webhook] processing error', err);
      fastify.log.error(err);
    }

    // Telegram only cares about the HTTP status — always ack so it doesn't retry forever.
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

  // SNS often posts as text/plain; accept json + text as raw string.
  await fastify.register(async function sesEmailWebhookScope(instance) {
    const asString = (_req: unknown, body: string, done: (err: null, body: string) => void) => {
      done(null, body);
    };
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, asString);
    instance.addContentTypeParser('text/plain', { parseAs: 'string' }, asString);

    instance.post('/ses-events', async (request, reply) => {
      const payload =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});

      try {
        const result = await handleSesEmailWebhook(payload);
        if (result.kind === 'subscription_confirmed') {
          fastify.log.info('SES SNS subscription confirmed');
        } else if (result.kind === 'notification' && result.updated) {
          fastify.log.info({ eventType: result.eventType }, 'SES email log updated');
        }
        return reply.send({ ok: true });
      } catch (err) {
        fastify.log.warn({ err }, 'SES SNS webhook rejected');
        return reply.code(400).send({ error: 'Invalid webhook' });
      }
    });
  });
}
