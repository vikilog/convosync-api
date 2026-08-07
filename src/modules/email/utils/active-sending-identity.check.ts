import assert from 'node:assert/strict';
import { domainFromEmail, pickActiveSendingEmail } from './active-sending-identity.js';

assert.equal(
  pickActiveSendingEmail({
    defaultProviderType: 'AWS_SES',
    defaultProviderStatus: 'active',
    defaultProviderSenderEmail: 'no-reply@dasalon.com',
    platformSharedEmail: 'convosync@convosync.io',
  }),
  'no-reply@dasalon.com',
  'SES default From must win over platform shared'
);

assert.equal(
  pickActiveSendingEmail({
    defaultProviderType: 'CONVOSYNC_MANAGED',
    defaultProviderStatus: 'active',
    defaultProviderSenderEmail: null,
    platformSharedEmail: 'acme@convosync.io',
  }),
  'acme@convosync.io',
  'managed default falls back to platform shared'
);

assert.equal(
  pickActiveSendingEmail({
    defaultProviderType: 'AWS_SES',
    defaultProviderStatus: 'disabled',
    defaultProviderSenderEmail: 'no-reply@dasalon.com',
    platformSharedEmail: 'acme@convosync.io',
  }),
  'acme@convosync.io',
  'disabled SES does not override platform'
);

assert.equal(
  pickActiveSendingEmail({
    defaultProviderType: 'AWS_SES',
    defaultProviderStatus: 'active',
    defaultProviderSenderEmail: null,
    platformSharedEmail: 'acme@convosync.io',
  }),
  'acme@convosync.io',
  'SES without From falls back to platform'
);

assert.equal(domainFromEmail('no-reply@dasalon.com'), 'dasalon.com');
assert.equal(domainFromEmail('convosync@convosync.io'), 'convosync.io');

console.log('active-sending-identity.check.ts: ok');
