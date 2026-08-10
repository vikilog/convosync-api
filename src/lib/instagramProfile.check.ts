/**
 * Run: npx tsx src/lib/instagramProfile.check.ts
 */
import assert from 'node:assert/strict';
import {
  isInstagramPlaceholderContactName,
  resolveInstagramContactName,
} from './instagramProfile.js';

const igsid = '178414057831409632';

assert.equal(isInstagramPlaceholderContactName('Instagram 409632', igsid), true);
assert.equal(isInstagramPlaceholderContactName(igsid, igsid), true);
assert.equal(isInstagramPlaceholderContactName('@eee_vikaswa', igsid), false);
assert.equal(isInstagramPlaceholderContactName('Vikas', igsid), false);

// Graph omitted name but username present — must not stick on IGSID seed / placeholder.
assert.equal(
  resolveInstagramContactName({ username: 'eee_vikaswa' }, igsid),
  '@eee_vikaswa'
);
// Polluted name field (old fetch seed) must yield to @username.
assert.equal(
  resolveInstagramContactName({ name: igsid, username: 'eee_vikaswa' }, igsid),
  '@eee_vikaswa'
);
assert.equal(
  resolveInstagramContactName({ name: 'Ada Lovelace', username: 'ada' }, igsid),
  'Ada Lovelace'
);
assert.equal(
  resolveInstagramContactName({}, igsid),
  'Instagram 409632'
);

console.log('instagramProfile.check: ok');
