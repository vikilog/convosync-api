/**
 * Run: npx tsx src/lib/messageResendStatus.check.ts
 */
import assert from 'node:assert/strict';
import {
  beginResend,
  canResendStatus,
  classifyDeliveryStatus,
  finishResend,
  mergeSendErrorMetadata,
} from './messageResendStatus.js';

assert.equal(canResendStatus('failed'), true);
assert.equal(canResendStatus('bounced'), true);
assert.equal(canResendStatus('resend_pending'), false);
assert.equal(canResendStatus('resent'), false);
assert.equal(canResendStatus('sent'), false);

assert.deepEqual(beginResend(0), { status: 'resend_pending', retryCount: 1 });
assert.deepEqual(beginResend(2), { status: 'resend_pending', retryCount: 3 });

assert.equal(finishResend(true), 'resent');
assert.equal(finishResend(false), 'failed');

assert.equal(classifyDeliveryStatus('failed'), 'failed');
assert.equal(classifyDeliveryStatus('resend_pending'), 'pending');
assert.equal(classifyDeliveryStatus('resent'), 'success');
assert.equal(classifyDeliveryStatus('delivered'), 'success');

const merged = mergeSendErrorMetadata({ templateId: 't1' }, 'boom');
assert.equal(merged.templateId, 't1');
assert.equal(merged.sendError, 'boom');

console.log('messageResendStatus.check: ok');
