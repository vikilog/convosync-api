/** Razorpay webhook envelope + payment entity shapes we actually read. */

export interface RazorpayWebhookPaymentEntity {
  id: string;
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  method?: string;
  error_code?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
  notes?: Record<string, string>;
  [key: string]: unknown;
}

export interface RazorpayWebhookSubscriptionEntity {
  id: string;
  status?: string;
  current_start?: number;
  current_end?: number;
  [key: string]: unknown;
}

export interface RazorpayWebhookEntityWrapper<T> {
  entity: T;
}

export interface RazorpayWebhookPayload {
  payment?: RazorpayWebhookEntityWrapper<RazorpayWebhookPaymentEntity>;
  subscription?: RazorpayWebhookEntityWrapper<RazorpayWebhookSubscriptionEntity>;
  invoice?: RazorpayWebhookEntityWrapper<Record<string, unknown>>;
  payment_link?: RazorpayWebhookEntityWrapper<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface RazorpayWebhookEvent {
  entity?: string;
  account_id?: string;
  event: string;
  contains?: string[];
  payload: RazorpayWebhookPayload;
  created_at?: number;
}

export function webhookPaymentEntity(
  payload: RazorpayWebhookPayload | Record<string, unknown>
): RazorpayWebhookPaymentEntity | undefined {
  const wrapper = payload.payment;
  if (!wrapper || typeof wrapper !== 'object') return undefined;
  const entity = (wrapper as RazorpayWebhookEntityWrapper<RazorpayWebhookPaymentEntity>).entity;
  if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string') return undefined;
  return entity;
}

export function webhookSubscriptionEntity(
  payload: RazorpayWebhookPayload | Record<string, unknown>
): RazorpayWebhookSubscriptionEntity | undefined {
  const wrapper = payload.subscription;
  if (!wrapper || typeof wrapper !== 'object') return undefined;
  const entity = (wrapper as RazorpayWebhookEntityWrapper<RazorpayWebhookSubscriptionEntity>)
    .entity;
  if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string') return undefined;
  return entity;
}
