/**
 * ponytail: CRM push payload + tag merge (no DB).
 * Run: npx tsx backend/src/services/pushOrganizationCrmContact.check.ts
 */
import assert from 'node:assert/strict';
import {
  buildCrmContactPayload,
  mergeContactTags,
  mergeCustomFields,
  resolveCrmContactPhone,
  CRM_CONTACT_TAGS,
} from './pushOrganizationCrmContact.helpers.js';

assert.equal(
  resolveCrmContactPhone({
    workspaceId: 'w1',
    ownerPhone: '+91 98765 43210',
    workspacePhone: '1111111111',
  }),
  '919876543210'
);

assert.equal(
  resolveCrmContactPhone({
    workspaceId: 'w1',
    ownerPhone: null,
    workspacePhone: '9876543210',
  }),
  '9876543210'
);

assert.equal(resolveCrmContactPhone({ workspaceId: 'w1' }), null);

const payload = buildCrmContactPayload({
  workspaceId: 'tenant-1',
  workspaceName: 'Acme Co',
  ownerName: 'Riya',
  ownerEmail: 'riya@acme.test',
  ownerPhone: '+919876543210',
  ownerJobTitle: 'Founder',
  country: 'IN',
  industry: 'SaaS',
});

assert.equal(payload.name, 'Riya');
assert.equal(payload.phone, '919876543210');
assert.equal(payload.email, 'riya@acme.test');
assert.deepEqual(payload.tags, [...CRM_CONTACT_TAGS]);
assert.equal(payload.customFields.companyName, 'Acme Co');
assert.equal(payload.customFields.tenantWorkspaceId, 'tenant-1');
assert.equal(payload.customFields.jobTitle, 'Founder');

assert.deepEqual(mergeContactTags(['signup', 'vip'], ['signup', 'convosync-client']), [
  'signup',
  'vip',
  'convosync-client',
]);

assert.deepEqual(
  mergeCustomFields({ companyName: 'Old', keep: 'yes' }, { companyName: 'New', country: 'IN' }),
  { companyName: 'New', keep: 'yes', country: 'IN' }
);

console.log('pushOrganizationCrmContact.check.ts: ok');
