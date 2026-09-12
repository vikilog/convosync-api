import assert from 'node:assert/strict';
import {
  createOutgoingWebhookSchema,
  updateIncomingWebhookSchema,
  upsertActionSchema,
  webhookLogsQuerySchema,
} from './developers.schemas.js';

assert.equal(updateIncomingWebhookSchema.safeParse({ enabled: true }).success, true);
assert.equal(updateIncomingWebhookSchema.safeParse({ enabled: 'yes' }).success, false);
assert.equal(
  createOutgoingWebhookSchema.safeParse({
    name: 'CRM',
    url: 'https://example.com/hook',
  }).success,
  true
);
assert.equal(
  createOutgoingWebhookSchema.safeParse({ name: 'CRM', url: 'not-a-url' }).success,
  false
);
assert.equal(
  upsertActionSchema.safeParse({ actionType: 'save_note', name: 'Note' }).success,
  true
);
assert.equal(upsertActionSchema.safeParse({ actionType: 'nope', name: 'X' }).success, false);
assert.equal(webhookLogsQuerySchema.safeParse({}).success, true);
assert.equal(webhookLogsQuerySchema.safeParse({ direction: 'incoming' }).success, true);
assert.equal(webhookLogsQuerySchema.safeParse({ direction: 'sideways' }).success, false);

console.log('developers.schemas.check.ts: ok');
