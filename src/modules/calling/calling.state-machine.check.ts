/**
 * State machine self-check for calling module.
 * Run: npx tsx backend/src/modules/calling/calling.state-machine.check.ts
 */
import assert from 'node:assert/strict';
import {
  canTransitionCallStatus,
  isTerminalCallStatus,
} from './calling.state-machine.js';

assert.equal(canTransitionCallStatus('initiated', 'ringing'), true);
assert.equal(canTransitionCallStatus('ringing', 'accepted'), true);
assert.equal(canTransitionCallStatus('accepted', 'connected'), true);
assert.equal(canTransitionCallStatus('connected', 'ended'), true);

assert.equal(canTransitionCallStatus('ringing', 'declined'), true);
assert.equal(canTransitionCallStatus('ringing', 'missed'), true);
assert.equal(canTransitionCallStatus('initiated', 'failed'), true);

assert.equal(canTransitionCallStatus('ended', 'ringing'), false);
assert.equal(canTransitionCallStatus('declined', 'accepted'), false);
assert.equal(canTransitionCallStatus('connected', 'ringing'), false);
assert.equal(canTransitionCallStatus('accepted', 'declined'), false);

assert.equal(isTerminalCallStatus('ended'), true);
assert.equal(isTerminalCallStatus('ringing'), false);

// idempotent same-status
assert.equal(canTransitionCallStatus('ringing', 'ringing'), true);

console.log('calling.state-machine.check.ts: ok');
