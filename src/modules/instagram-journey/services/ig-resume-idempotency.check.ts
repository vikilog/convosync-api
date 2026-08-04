/**
 * Runnable check: resume message-id idempotency guard.
 * Run: npx tsx src/modules/instagram-journey/services/ig-resume-idempotency.check.ts
 */
import assert from 'node:assert/strict';

function shouldSkipResume(opts: {
  resumeMessageId?: string;
  incomingMessageId?: string;
}): boolean {
  return Boolean(
    opts.incomingMessageId && opts.resumeMessageId === opts.incomingMessageId
  );
}

assert.equal(shouldSkipResume({ resumeMessageId: 'm1', incomingMessageId: 'm1' }), true);
assert.equal(shouldSkipResume({ resumeMessageId: 'm1', incomingMessageId: 'm2' }), false);
assert.equal(shouldSkipResume({ incomingMessageId: 'm1' }), false);

console.log('ig-resume-idempotency check ok');
