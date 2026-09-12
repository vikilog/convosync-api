import assert from 'node:assert/strict';
import {
  createDomainSchema,
  createSenderSchema,
  listLogsSchema,
  saveWorkspaceEmailConfigSchema,
  sendEmailSchema,
  sesCredentialsDraftBodySchema,
  sesCredentialsDraftSchema,
  setDefaultSenderSchema,
  verifyDomainSchema,
} from './email.schemas.js';

assert.equal(createDomainSchema.safeParse({ domain: 'example.com' }).success, true);
assert.equal(createDomainSchema.safeParse({ domain: 'nope' }).success, false);
assert.equal(verifyDomainSchema.safeParse({ domainId: 'd1' }).success, true);
assert.equal(verifyDomainSchema.safeParse({}).success, false);
assert.equal(listLogsSchema.safeParse({}).success, true);
assert.equal(listLogsSchema.safeParse({ limit: '10' }).success, true);
assert.equal(listLogsSchema.safeParse({ limit: 0 }).success, false);

assert.equal(createSenderSchema.safeParse({ email: 'support@example.com' }).success, true);
assert.equal(createSenderSchema.safeParse({ email: 'not-email' }).success, false);
assert.equal(setDefaultSenderSchema.safeParse({ email: 'a@b.co' }).success, true);
assert.equal(setDefaultSenderSchema.safeParse({}).success, false);

assert.equal(
  sendEmailSchema.safeParse({ to: 'a@b.co', subject: 'Hi', html: '<p>x</p>' }).success,
  true
);
assert.equal(sendEmailSchema.safeParse({ to: 'a@b.co' }).success, false);

assert.equal(sesCredentialsDraftSchema.safeParse({}).success, true);
assert.equal(sesCredentialsDraftSchema.safeParse({ senderEmail: 'bad' }).success, false);
assert.equal(sesCredentialsDraftBodySchema.safeParse(undefined).success, true);
assert.equal(sesCredentialsDraftBodySchema.safeParse(null).success, true);

assert.equal(saveWorkspaceEmailConfigSchema.safeParse({ useOwnEmail: false }).success, true);
assert.equal(saveWorkspaceEmailConfigSchema.safeParse({}).success, false);

console.log('email.schemas.check.ts: ok');
