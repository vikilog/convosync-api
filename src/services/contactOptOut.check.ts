import assert from 'node:assert';
import { isOptOutMessage } from './contactOptOut.service.js';

// Should match.
for (const text of ['STOP', 'stop', ' Stop ', 'Stop.', 'unsubscribe', 'Unsubscribe!', 'opt out', 'OPTOUT', 'cancel']) {
  assert.strictEqual(isOptOutMessage(text), true, `expected "${text}" to be an opt-out message`);
}

// Should NOT match — substring/sentence false positives are the whole risk here.
for (const text of [
  "please don't stop the great service",
  'stop calling me at night',
  'I want to cancel my order, not unsubscribe',
  'hello',
  '',
  'unsubscribe me please if you can',
]) {
  assert.strictEqual(isOptOutMessage(text), false, `expected "${text}" to NOT be an opt-out message`);
}

console.log('contactOptOut.check.ts: ok');
