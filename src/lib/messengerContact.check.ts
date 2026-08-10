/**
 * Run: npx tsx src/lib/messengerContact.check.ts
 */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  formatMessengerContactPhone,
  normalizeMessengerPsid,
  parseMessengerPsid,
} from './channelContact.js';
import { isPrismaUniqueViolation } from './messengerContact.js';

assert.equal(formatMessengerContactPhone('1234567890123456'), 'fb:1234567890123456');
assert.equal(normalizeMessengerPsid('fb:123'), '123');
assert.equal(normalizeMessengerPsid('ig:123'), '', 'ig: must not coerce to Messenger PSID');
assert.equal(normalizeMessengerPsid(' 999 '), '999');

assert.equal(parseMessengerPsid('fb:36586673007584588'), '36586673007584588');
// Legacy bare PSID (no fb:) — long digit ids only
assert.equal(parseMessengerPsid('36586673007584588'), '36586673007584588');
assert.equal(parseMessengerPsid('919992492168'), null, 'WA-length digits are not PSIDs');
assert.equal(parseMessengerPsid('ig:36586673007584588'), null);

const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
  code: 'P2002',
  clientVersion: 'test',
  meta: { target: ['phone', 'workspaceId'] },
});
assert.equal(isPrismaUniqueViolation(p2002), true);
assert.equal(isPrismaUniqueViolation(new Error('nope')), false);
assert.equal(isPrismaUniqueViolation({ code: 'P2002' }), false);

console.log('messengerContact.check: ok');
