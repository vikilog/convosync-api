/** Developer platform constants — shared by webhooks, actions, and event bus. */

export const DEVELOPER_ACTION_TYPES = [
  'create_booking',
  'cancel_booking',
  'update_booking',
  'create_customer',
  'search_slots',
  'search_products',
  'search_services',
  'save_note',
] as const;

export type DeveloperActionType = (typeof DEVELOPER_ACTION_TYPES)[number];

export const DEVELOPER_WEBHOOK_EVENTS = [
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

export type DeveloperWebhookEvent = (typeof DEVELOPER_WEBHOOK_EVENTS)[number];

export const DEVELOPER_SYNC_EVENT_TYPES = [
  'knowledge.rebuild',
  'knowledge.collection_sync',
] as const;

export type DeveloperSyncEventType = (typeof DEVELOPER_SYNC_EVENT_TYPES)[number];

export type DeveloperActionRecord = {
  id: string;
  actionType: DeveloperActionType;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  enabled: boolean;
  updatedAt: string;
};

export type IncomingWebhookRecord = {
  id: string;
  slug: string;
  secret: string;
  enabled: boolean;
  subscribedEvents: string[];
  webhookUrl: string;
  lastEventAt: string | null;
  createdAt: string;
};

export type OutgoingWebhookRecord = {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  enabled: boolean;
  subscribedEvents: string[];
  maxRetries: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookLogRecord = {
  id: string;
  direction: 'incoming' | 'outgoing';
  eventType: string;
  status: string;
  statusCode: number | null;
  attempt: number;
  errorMessage: string | null;
  outgoingWebhookId: string | null;
  createdAt: string;
};

export type AiSyncDashboard = {
  connectionStatus: 'connected' | 'disconnected' | 'syncing' | 'failed' | 'not_configured';
  lastSyncTime: string | null;
  lastEventTime: string | null;
  venueId: string | null;
  knowledgeHealth: {
    services: number;
    products: number;
    customers: number;
    staff: number;
  };
  pendingQueueJobs: number;
  failedEvents: number;
};

export type DeveloperSyncEventRecord = {
  id: string;
  eventType: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
};
