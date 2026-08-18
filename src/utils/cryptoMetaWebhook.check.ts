import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { safeStringEquals, verifyMetaWebhookSignature } from './crypto.utils.js';

const secret = 'test-app-secret';
const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const validSig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

assert.strictEqual(verifyMetaWebhookSignature(body, validSig, secret), true, 'valid signature must pass');
assert.strictEqual(
  verifyMetaWebhookSignature(body, 'sha256=' + '0'.repeat(64), secret),
  false,
  'wrong signature must fail'
);
assert.strictEqual(verifyMetaWebhookSignature(body, undefined, secret), false, 'missing header must fail');
assert.strictEqual(verifyMetaWebhookSignature(body, validSig, ''), false, 'missing secret must fail');
assert.strictEqual(
  verifyMetaWebhookSignature(body, validSig.replace('sha256=', ''), secret),
  false,
  'header without sha256= prefix must fail'
);
assert.strictEqual(
  verifyMetaWebhookSignature('tampered body', validSig, secret),
  false,
  'body must match exactly what was signed'
);

assert.strictEqual(safeStringEquals('abc', 'abc'), true, 'equal strings match');
assert.strictEqual(safeStringEquals('abc', 'abd'), false, 'different strings do not match');
assert.strictEqual(safeStringEquals(undefined, 'abc'), false, 'undefined never matches');
assert.strictEqual(safeStringEquals('abc', undefined), false, 'undefined never matches (rhs)');

console.log('cryptoMetaWebhook.check.ts: ok');
