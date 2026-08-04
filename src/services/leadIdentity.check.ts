/**
 * Runnable check: contact → lead identity field resolution.
 * Run: npx tsx src/services/leadIdentity.check.ts
 */
import assert from 'node:assert/strict';
import { resolveContactIdentityFields } from './leadIdentity.ts';

assert.deepEqual(
  resolveContactIdentityFields({
    name: 'Ada',
    email: 'ada@example.com',
    phone: '+15551212',
  }),
  { name: 'Ada', email: 'ada@example.com', phone: '+15551212' }
);

assert.deepEqual(
  resolveContactIdentityFields({
    name: null,
    email: null,
    phone: null,
    customFields: { name: 'Bob', email: 'bob@x.com', phone: '999' },
  }),
  { name: 'Bob', email: 'bob@x.com', phone: '999' }
);

assert.deepEqual(
  resolveContactIdentityFields({
    name: 'Col',
    email: null,
    phone: '  ',
    customFields: { email: 'col@x.com', phone: '111' },
  }),
  { name: 'Col', email: 'col@x.com', phone: '111' }
);

assert.deepEqual(
  resolveContactIdentityFields({
    name: '  ',
    email: null,
    phone: null,
    customFields: { note: 'skip me' },
  }),
  {}
);

console.log('leadIdentity.check: ok');
