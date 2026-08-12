/**
 * Runnable check: payload truncation + Meta/Razorpay webhook describe.
 * Run: npx tsx src/services/webhookEventLog.check.ts
 */
import assert from 'node:assert/strict';
import {
  WEBHOOK_PAYLOAD_MAX_CHARS,
  describeMetaWebhook,
  describeRazorpayWebhook,
  truncateJsonPayload,
} from './webhookEventLog.service.js';

const small = truncateJsonPayload({ a: 1 });
assert.deepEqual(small, { a: 1 });

const big = 'x'.repeat(WEBHOOK_PAYLOAD_MAX_CHARS + 50);
const truncated = truncateJsonPayload({ blob: big }) as {
  _truncated?: boolean;
  chars?: number;
  preview?: string;
};
assert.equal(truncated._truncated, true);
assert.ok((truncated.chars ?? 0) > WEBHOOK_PAYLOAD_MAX_CHARS);
assert.ok((truncated.preview?.length ?? 0) <= WEBHOOK_PAYLOAD_MAX_CHARS);

const statusDesc = describeMetaWebhook({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pn1' },
            statuses: [
              {
                status: 'failed',
                recipient_id: '9199',
                errors: [{ code: 131026, message: 'Message undeliverable' }],
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.equal(statusDesc.source, 'whatsapp');
assert.equal(statusDesc.eventType, 'statuses');
assert.equal(statusDesc.phoneNumberId, 'pn1');
assert.match(statusDesc.summary, /131026/);
assert.match(statusDesc.summary, /undeliverable/i);

const tmpl = describeMetaWebhook({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'message_template_status_update',
          value: {
            message_template_name: 'order_confirm',
            event: 'REJECTED',
          },
        },
      ],
    },
  ],
});
assert.equal(tmpl.eventType, 'message_template_status_update');
assert.match(tmpl.summary, /order_confirm/);
assert.match(tmpl.summary, /REJECTED/);

const rzp = describeRazorpayWebhook({
  entity: 'event',
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: 'pay_abc',
        status: 'captured',
        amount: 49900,
        currency: 'INR',
        notes: { workspaceId: 'ws_1' },
      },
    },
  },
});
assert.equal(rzp.source, 'razorpay');
assert.equal(rzp.eventType, 'payment.captured');
assert.equal(rzp.workspaceId, 'ws_1');
assert.match(rzp.summary, /pay_abc/);
assert.match(rzp.summary, /captured/);

const link = describeRazorpayWebhook({
  event: 'payment_link.paid',
  payload: {
    payment_link: {
      entity: {
        id: 'plink_1',
        status: 'paid',
        notes: { purpose: 'billing_offer' },
      },
    },
  },
});
assert.equal(link.eventType, 'payment_link.paid');
assert.match(link.summary, /billing_offer/);

console.log('webhookEventLog.check.ts: ok');
