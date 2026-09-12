import assert from 'node:assert/strict';
import {
  normalizeCompanyEmail,
  normalizeCompanyPhone,
  sessionUserView,
  shouldClearVerifiedAt,
  workspaceSlugFromName,
} from './identity.helpers.js';

assert.equal(workspaceSlugFromName("Acme Co", 1700000000000), 'acme-co-1700000000000');
assert.equal(workspaceSlugFromName('Solo', 1), 'solo-1');

assert.equal(normalizeCompanyEmail(undefined), undefined);
assert.equal(normalizeCompanyEmail(null), null);
assert.equal(normalizeCompanyEmail(''), null);
assert.equal(normalizeCompanyEmail('  A@B.Co  '), 'a@b.co');

assert.equal(normalizeCompanyPhone(undefined), undefined);
assert.equal(normalizeCompanyPhone(null), null);
assert.equal(normalizeCompanyPhone(''), null);
assert.equal(normalizeCompanyPhone('+1 (415) 555-0100'), '14155550100');

assert.equal(shouldClearVerifiedAt('a@b.co', 'a@b.co'), false);
assert.equal(shouldClearVerifiedAt('a@b.co', 'c@d.co'), true);
assert.equal(shouldClearVerifiedAt(null, null), false);
assert.equal(shouldClearVerifiedAt(null, 'a@b.co'), true);

const view = sessionUserView(
  { id: 'u1', name: 'Ada', email: 'ada@x.co', avatar: null },
  { role: 'admin', permissions: ['settings'], inboxScope: { mode: 'all' } },
  { onboardingStep: 1 }
);
assert.equal(view.id, 'u1');
assert.equal(view.role, 'admin');
assert.equal(view.onboardingStep, 1);

console.log('identity.helpers.check.ts: ok');
