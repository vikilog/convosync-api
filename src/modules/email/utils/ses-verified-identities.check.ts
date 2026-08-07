/**
 * Self-check: SES verified-identity parsing / sender allow rules.
 * Run: npx tsx src/modules/email/utils/ses-verified-identities.check.ts
 */
import assert from 'node:assert/strict';
import {
  filterVerifiedIdentities,
  isSenderAllowedByIdentities,
  mergeIdentityNames,
  parseCachedVerifiedIdentities,
  sesVerifiedIdentitiesConsoleUrl,
  verificationStatusOf,
} from './ses-verified-identities.ts';

const filtered = filterVerifiedIdentities(
  ['a@example.com', 'example.org', 'pending@x.com', ''],
  {
    'a@example.com': { VerificationStatus: 'Success' },
    'example.org': { VerificationStatus: 'Success' },
    'pending@x.com': { VerificationStatus: 'Pending' },
  }
);
// Domains first (Domain section), then emails.
assert.deepEqual(filtered, [
  { identity: 'example.org', type: 'domain' },
  { identity: 'a@example.com', type: 'email' },
]);

assert.equal(isSenderAllowedByIdentities('a@example.com', filtered), true);
assert.equal(isSenderAllowedByIdentities('noreply@example.org', filtered), true);
assert.equal(isSenderAllowedByIdentities('other@elsewhere.com', filtered), false);

// Attribute key case mismatch must still resolve Success.
assert.equal(
  verificationStatusOf('Example.ORG', {
    'example.org': { VerificationStatus: 'Success' },
  }),
  'Success'
);
assert.deepEqual(
  filterVerifiedIdentities(['Example.ORG'], {
    'example.org': { VerificationStatus: 'Success' },
  }),
  [{ identity: 'Example.ORG', type: 'domain' }]
);

assert.deepEqual(
  mergeIdentityNames(['a@x.com', 'x.com'], ['x.com', 'b@x.com'], undefined),
  ['a@x.com', 'x.com', 'b@x.com']
);

const cached = parseCachedVerifiedIdentities([
  { identity: 'b@x.com', type: 'email' },
  { identity: 'y.com' },
  { identity: '  ' },
  null,
]);
assert.deepEqual(cached, [
  { identity: 'b@x.com', type: 'email' },
  { identity: 'y.com', type: 'domain' },
]);

assert.match(sesVerifiedIdentitiesConsoleUrl('ap-south-1'), /region=ap-south-1/);
assert.match(sesVerifiedIdentitiesConsoleUrl('ap-south-1'), /verified-identities/);

console.log('ses-verified-identities.check.ts: ok');
