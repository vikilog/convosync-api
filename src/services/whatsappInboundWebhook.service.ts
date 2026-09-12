import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import {
  resolveWorkspaceByPhoneNumberId,
  resolveWorkspaceByWabaId,
} from './workspaceResolve.js';
import { handleMetaMessagingWebhook } from './metaMessagingWebhook.js';
import { type PageMessagingWebhookBody } from './instagramWebhookHandler.js';
import { routeInboundWhatsApp } from './conversation-inbound-router.service.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import {
  extractWhatsAppProfileName,
  upsertWhatsAppContact,
  type WhatsAppWebhookContact,
} from '../lib/whatsappContact.js';
import {
  handleCoexistenceHistoryWebhook,
  handleSmbAppStateSync,
  handleSmbMessageEchoes,
} from './whatsappCoexistenceWebhook.js';
import {
  fetchAndStoreInboundMedia,
  isSkippedInbound,
  parseInboundWhatsAppMessage,
  previewForMessage,
  type MessageMediaMetadata,
} from './whatsappMedia.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { isOptOutMessage, markContactUnsubscribed } from './contactOptOut.service.js';
import { syncFlowResponseToDataTable } from './dataTableFlowSync.service.js';
import { tagContactOnFlowCompletion } from './flowCompletionTag.service.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import {
  mergeWhatsAppStatusMetadata,
  normalizeWhatsAppStatusErrors,
  shouldAdvanceWhatsAppStatus,
  type WhatsAppStatusUpdate,
} from '../lib/whatsappStatusErrors.js';
import { redactWebhookPayload } from '../lib/webhookRedact.js';
import type { WhatsAppInboundWebhookBody } from '../queue/whatsapp-inbound.queue.js';

function logWebhook(label: string, payload: unknown) {
  const safe = typeof payload === 'string' ? payload : redactWebhookPayload(payload);
  console.log(`[WhatsApp Webhook] ${label}`, typeof safe === 'string' ? safe : JSON.stringify(safe));
}

/**
 * HMAC already verified on the HTTP path. Worker runs media / AI / persist.
 */
export async function processWhatsAppInboundWebhook(body: WhatsAppInboundWebhookBody): Promise<void> {
  if (body?.object === 'page' || body?.object === 'instagram') {
    logWebhook('POST → forwarding Page/Instagram payload to Meta messaging handler', {
      object: body.object,
    });
    try {
      await handleMetaMessagingWebhook(body as PageMessagingWebhookBody);
    } catch (err) {
      logWebhook('POST → Meta messaging forward error', err instanceof Error ? err.message : String(err));
      console.error(err);
    }
    return;
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
    return;
  }

  if (field === 'smb_app_state_sync') {
    await handleSmbAppStateSync(value);
    return;
  }

  if (field === 'history') {
    await handleCoexistenceHistoryWebhook(value);
    return;
  }

  if (value?.messages?.[0]) {
    const msg = value.messages[0];
    const from = msg.from;
    const parsed = parseInboundWhatsAppMessage(msg);
    const waNumberId = value.metadata?.phone_number_id;

    if (isSkippedInbound(parsed)) {
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

          const lastPreview = previewForMessage(parsed.kind, displayContent, parsed.media?.caption);

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

          if (parsed.sender !== 'system' && !parsed.reaction && isOptOutMessage(displayContent)) {
            try {
              const tagged = await markContactUnsubscribed(contact.id, workspace.id);
              if (tagged) {
                const credentials = await getWorkspaceWhatsAppCredentials(workspace.id, waNumberId);
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

          if (parsed.flowResponse) {
            try {
              await syncFlowResponseToDataTable({
                workspaceId: workspace.id,
                fields: parsed.flowResponse.fields,
              });
            } catch (syncErr) {
              logWebhook(
                'POST → data table sync error',
                syncErr instanceof Error ? syncErr.message : syncErr
              );
            }
            try {
              await tagContactOnFlowCompletion({
                workspaceId: workspace.id,
                contactId: contact.id,
                fields: parsed.flowResponse.fields,
              });
            } catch (tagErr) {
              logWebhook(
                'POST → flow completion tag error',
                tagErr instanceof Error ? tagErr.message : tagErr
              );
            }
          }

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
              console.error(flowErr);
            }
          }
        }
      }
    }
  }

  for (const statusUpdate of value?.statuses ?? []) {
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
      const advance = shouldAdvanceWhatsAppStatus(message.status, statusUpdate.status);
      await prisma.message.update({
        where: { id: message.id },
        data: {
          ...(advance ? { status: statusUpdate.status } : {}),
          metadata: metadata as object,
        },
      });
      if (advance) {
        getIo().to(message.conversation.workspaceId).emit('message_status', {
          messageId: message.id,
          status: statusUpdate.status,
          ...(statusErrors.length ? { errors: statusErrors } : {}),
        });
      }
      logWebhook('POST → status applied', {
        messageId: message.id,
        status: statusUpdate.status,
        advanced: advance,
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
            const { emitNotification } = await import('../services/notifications/emitNotification.js');
            const { NOTIFICATION_TYPES } = await import('../services/notifications/types.js');
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
              title: event === 'APPROVED' ? 'Template approved' : 'Template rejected',
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
}
