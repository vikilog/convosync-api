import { eventBus } from '../../journey/events/event-bus.js';
import type { WebhooksService } from './webhooks.service.js';

type PlatformEventPayload = {
  workspaceId: string;
  [key: string]: unknown;
};

/** Bridges platform event bus → outgoing developer webhooks. */
export function registerDeveloperEventListeners(webhooks: WebhooksService): void {
  const events = [
    'contact.created',
    'contact.updated',
    'message.received',
    'message.sent',
    'booking.created',
    'booking.updated',
    'booking.cancelled',
    'knowledge.synced',
    'knowledge.failed',
    'knowledge.rebuild.requested',
  ] as const;

  for (const event of events) {
    eventBus.on<PlatformEventPayload>(event, async (payload) => {
      if (!payload?.workspaceId) return;
      await webhooks.dispatchOutgoingEvent(payload.workspaceId, event, payload);
    });
  }
}
