import assert from 'node:assert';
import { signUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribeToken.service.js';

// Round-trip.
const token = signUnsubscribeToken('contact_123', 'ws_abc');
const claims = verifyUnsubscribeToken(token);
assert.strictEqual(claims.contactId, 'contact_123');
assert.strictEqual(claims.workspaceId, 'ws_abc');
assert.strictEqual(claims.purpose, 'email_unsubscribe');

// Tampered payload (different contact) must fail signature verification.
const [, sig] = token.split('.');
const forged = `${Buffer.from(JSON.stringify({ purpose: 'email_unsubscribe', contactId: 'contact_999', workspaceId: 'ws_abc' })).toString('base64url')}.${sig}`;
assert.throws(() => verifyUnsubscribeToken(forged), /Invalid unsubscribe link/);

// Garbage / malformed tokens must fail cleanly, not throw an unrelated error.
assert.throws(() => verifyUnsubscribeToken('not-a-real-token'), /Invalid unsubscribe link/);
assert.throws(() => verifyUnsubscribeToken(''), /Invalid unsubscribe link/);
assert.throws(() => verifyUnsubscribeToken('a.b.c'), /Invalid unsubscribe link/);

console.log('unsubscribeToken.check.ts: ok');
