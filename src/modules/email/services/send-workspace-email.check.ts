/**
 * Self-check: encryptSecret round-trip for SES keys + provider resolution rules.
 * Run: npx tsx src/modules/email/services/send-workspace-email.check.ts
 */
import assert from 'node:assert/strict';
import {
  SECRET_PREFIX,
  decryptSecret,
  encryptSecret,
} from '../../../lib/field-encryption.ts';
import { toPublicEmailConfig } from './workspace-email-config.service.ts';
import { formatSesSendError } from '../utils/ses-errors.ts';

process.env.ENCRYPTION_KEY ??= 'test-workspace-email-encryption-key';

// Encryption round-trip (same pattern as waToken)
const accessKey = 'AKIAEXAMPLEKEY1234';
const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const encAccess = encryptSecret(accessKey);
const encSecret = encryptSecret(secret);
assert.ok(encAccess.startsWith(SECRET_PREFIX));
assert.ok(encSecret.startsWith(SECRET_PREFIX));
assert.equal(decryptSecret(encAccess), accessKey);
assert.equal(decryptSecret(encSecret), secret);

// Public view never leaks secret; access key is masked
const fetchedAt = new Date('2026-08-07T12:00:00.000Z');
const publicView = toPublicEmailConfig({
  workspaceId: 'ws_test',
  provider: 'ses',
  accessKeyIdEncrypted: encAccess,
  secretAccessKeyEncrypted: encSecret,
  region: 'ap-south-1',
  senderEmail: 'noreply@example.com',
  verifiedIdentities: [{ identity: 'noreply@example.com', type: 'email' }],
  identitiesFetchedAt: fetchedAt,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});
assert.equal(publicView.provider, 'ses');
assert.equal(publicView.isActive, true);
assert.equal(publicView.hasSecretAccessKey, true);
assert.ok(publicView.accessKeyIdMasked);
assert.ok(!publicView.accessKeyIdMasked.includes(accessKey.slice(4, -4)));
assert.notEqual(publicView.accessKeyIdMasked, accessKey);
assert.deepEqual(publicView.verifiedIdentities, [
  { identity: 'noreply@example.com', type: 'email' },
]);
assert.equal(publicView.identitiesFetchedAt, fetchedAt.toISOString());
assert.match(publicView.sesConsoleUrl ?? '', /ap-south-1/);

// Platform / inactive → not treated as active SES
const platformView = toPublicEmailConfig({
  workspaceId: 'ws_test',
  provider: 'platform',
  accessKeyIdEncrypted: encAccess,
  secretAccessKeyEncrypted: encSecret,
  region: 'ap-south-1',
  senderEmail: 'noreply@example.com',
  verifiedIdentities: null,
  identitiesFetchedAt: null,
  isActive: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});
assert.equal(platformView.isActive, false);
assert.equal(platformView.provider, 'platform');
assert.deepEqual(platformView.verifiedIdentities, []);

// SES error formatting
assert.match(
  formatSesSendError({ name: 'InvalidClientTokenId', message: 'The security token included in the request is invalid' }),
  /Invalid AWS credentials/i
);
assert.match(
  formatSesSendError({
    name: 'MessageRejected',
    message: 'Email address is not verified. Your account is still in the sandbox.',
  }),
  /Sandbox|verified/i
);

console.log('send-workspace-email.check.ts: ok');
