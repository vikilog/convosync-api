/**
 * Self-check: email webhook → inbox Message.status mapping.
 * Run: npx tsx backend/src/modules/email/utils/email-event-status.check.ts
 */
import assert from 'node:assert/strict';
import {
  mapEmailLogStatusToMessageStatus,
  shouldAdvanceEmailStatus,
} from './email-event-status.ts';

assert.equal(mapEmailLogStatusToMessageStatus('sent'), 'sent');
assert.equal(mapEmailLogStatusToMessageStatus('delivered'), 'delivered');
assert.equal(mapEmailLogStatusToMessageStatus('opened'), 'read');
assert.equal(mapEmailLogStatusToMessageStatus('clicked'), 'read');
assert.equal(mapEmailLogStatusToMessageStatus('bounced'), 'failed');
assert.equal(mapEmailLogStatusToMessageStatus('complained'), 'failed');
assert.equal(mapEmailLogStatusToMessageStatus('rejected'), 'failed');
assert.equal(mapEmailLogStatusToMessageStatus('failed'), 'failed');
assert.equal(mapEmailLogStatusToMessageStatus('queued'), 'sent');

assert.equal(shouldAdvanceEmailStatus('sent', 'delivered'), true);
assert.equal(shouldAdvanceEmailStatus('delivered', 'opened'), true);
assert.equal(shouldAdvanceEmailStatus('opened', 'clicked'), true);
assert.equal(shouldAdvanceEmailStatus('read', 'clicked'), true);
assert.equal(shouldAdvanceEmailStatus('clicked', 'delivered'), false);
assert.equal(shouldAdvanceEmailStatus('opened', 'delivered'), false);

console.log('email-event-status.check.ts: ok');
