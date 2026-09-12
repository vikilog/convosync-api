import assert from 'node:assert/strict';
import { redactWebhookPayload } from './webhookRedact.js';

const raw = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: '123', display_phone_number: '919999999999' },
            contacts: [{ wa_id: '918888888888', profile: { name: 'Ada' } }],
            messages: [{ from: '918888888888', text: { body: 'secret hi' }, id: 'wamid.1' }],
          },
        },
      ],
    },
  ],
};

const redacted = redactWebhookPayload(raw) as typeof raw;
const value = redacted.entry[0].changes[0].value;

assert.equal(value.messages[0].id, 'wamid.1', 'message id stays');
assert.equal(value.metadata.phone_number_id, '123', 'WABA id stays');
assert.equal(value.messages[0].from, '[redacted]');
assert.equal(value.messages[0].text, '[redacted]');
assert.equal(value.contacts, '[redacted]');
assert.equal(value.metadata.display_phone_number, '[redacted]');
assert.equal(redactWebhookPayload('ok'), 'ok', 'plain status strings stay');

const dumped = JSON.stringify(redacted);
assert.equal(dumped.includes('secret hi'), false);
assert.equal(dumped.includes('918888888888'), false);
assert.equal(dumped.includes('Ada'), false);

console.log('webhookRedact.check.ts: ok');
