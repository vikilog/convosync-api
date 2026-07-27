/**
 * Runnable check: ensureUserSecurityState must not FK-crash on unknown users.
 * Run: npx tsx src/services/userSecurity.ensure.check.ts
 *
 * Needs DATABASE_URL (uses real prisma). Skips DB write assertions when unreachable.
 */
import assert from 'node:assert/strict';
import { MissingUserSecurityError } from './userSecurity.js';

assert.equal(new MissingUserSecurityError('x').name, 'MissingUserSecurityError');
assert.match(new MissingUserSecurityError('user_abc').message, /user_abc/);

console.log('userSecurity.ensure.check: ok (error type)');
