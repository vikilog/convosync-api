import assert from 'node:assert/strict';
import { addMemberSchema, normalizeOptionalUrls } from './workspace.schemas.js';

assert.deepEqual(normalizeOptionalUrls({ website: '', email: 'a@b.co', logoUrl: '' }), {
  website: null,
  email: 'a@b.co',
  logoUrl: null,
});

assert.equal(addMemberSchema.safeParse({ email: 'not-email' }).success, false);
assert.equal(addMemberSchema.safeParse({ email: 'a@b.co' }).success, true);

console.log('workspace.schemas.check.ts: ok');
