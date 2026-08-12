/**
 * Self-check: SNS/SES event parsers + config-set naming.
 * Run: npx tsx src/modules/email/utils/ses-event-parser.check.ts
 */
import assert from 'node:assert/strict';
import {
  extractSesEventDetail,
  extractSesMessageId,
  mapSesEventToStatus,
  parseSesEventFromSnsMessage,
  parseSnsEnvelope,
  sesEventType,
} from './ses-event-parser.ts';
import { sesConfigSetNameForWorkspace, sesSnsTopicNameForWorkspace } from './ses-config-set-name.ts';
import { shouldAdvanceEmailStatus, mapEmailLogStatusToMessageStatus } from './email-event-status.ts';

const confirmRaw = JSON.stringify({
  Type: 'SubscriptionConfirmation',
  SubscribeURL: 'https://sns.example.com/confirm?token=abc',
  Token: 'abc',
});
const confirm = parseSnsEnvelope(confirmRaw);
assert.equal(confirm.Type, 'SubscriptionConfirmation');
assert.ok(confirm.SubscribeURL?.includes('confirm'));

const sesMessage = {
  eventType: 'Delivery',
  mail: { messageId: '0100018f-aaaa-bbbb-cccc-ddddeeeeffff-000000' },
  delivery: { timestamp: '2026-01-01T00:00:00.000Z' },
};
const notif = parseSnsEnvelope(
  JSON.stringify({
    Type: 'Notification',
    Message: JSON.stringify(sesMessage),
  })
);
const event = parseSesEventFromSnsMessage(notif.Message!);
assert.equal(sesEventType(event), 'Delivery');
assert.equal(mapSesEventToStatus(sesEventType(event)), 'delivered');
assert.equal(extractSesMessageId(event), '0100018f-aaaa-bbbb-cccc-ddddeeeeffff-000000');

assert.equal(mapSesEventToStatus('open'), 'opened');
assert.equal(mapSesEventToStatus('click'), 'clicked');
assert.equal(mapSesEventToStatus('bounce'), 'bounced');
assert.equal(mapSesEventToStatus('complaint'), 'complained');
assert.equal(mapSesEventToStatus('reject'), 'rejected');
assert.equal(mapSesEventToStatus('send'), 'sent');

const bounceDetail = extractSesEventDetail({
  eventType: 'Bounce',
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [{ diagnosticCode: '550 user unknown' }],
  },
});
assert.equal(bounceDetail, 'Permanent/General: 550 user unknown');

assert.equal(shouldAdvanceEmailStatus('sent', 'delivered'), true);
assert.equal(shouldAdvanceEmailStatus('opened', 'delivered'), false);
assert.equal(shouldAdvanceEmailStatus('delivered', 'bounced'), true);
assert.equal(shouldAdvanceEmailStatus('read', 'clicked'), true);
assert.equal(shouldAdvanceEmailStatus('clicked', 'opened'), false);

assert.equal(mapEmailLogStatusToMessageStatus('sent'), 'sent');
assert.equal(mapEmailLogStatusToMessageStatus('delivered'), 'delivered');
assert.equal(mapEmailLogStatusToMessageStatus('opened'), 'read');
assert.equal(mapEmailLogStatusToMessageStatus('clicked'), 'read');
assert.equal(mapEmailLogStatusToMessageStatus('bounced'), 'failed');
assert.equal(mapEmailLogStatusToMessageStatus('failed'), 'failed');

const name = sesConfigSetNameForWorkspace('clxyz_bad!chars');
assert.match(name, /^[a-zA-Z0-9_-]+$/);
assert.ok(name.length <= 64);
assert.ok(sesSnsTopicNameForWorkspace('ws1').startsWith('convosync-email-'));

console.log('ses-event-parser.check: ok');
