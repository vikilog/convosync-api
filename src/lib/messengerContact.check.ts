/**
 * Run: npx tsx src/lib/messengerContact.check.ts
 */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { formatMessengerContactPhone } from './channelContact.js';
import { isPrismaUniqueViolation } from './messengerContact.js';

assert.equal(formatMessengerContactPhone('1234567890'), 'fb:1234567890');

const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
  code: 'P2002',
  clientVersion: 'test',
  meta: { target: ['phone', 'workspaceId'] },
});
assert.equal(isPrismaUniqueViolation(p2002), true);
assert.equal(isPrismaUniqueViolation(new Error('nope')), false);
assert.equal(isPrismaUniqueViolation({ code: 'P2002' }), false);

console.log('messengerContact.check: ok');
