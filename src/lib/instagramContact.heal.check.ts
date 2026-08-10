/**
 * Pure assertions for IG/Messenger identity helpers used in contact heal.
 * Run: npx tsx src/lib/instagramContact.heal.check.ts
 */
import assert from 'node:assert/strict';
import {
  formatInstagramContactPhone,
  formatMessengerContactPhone,
  isInstagramPhone,
  isInstagramSource,
  isMessengerPhone,
  isMessengerSource,
  normalizeMessengerPsid,
} from './channelContact.js';

const igsid = '17841405783187240';

assert.equal(formatInstagramContactPhone(igsid), `ig:${igsid}`);
assert.equal(formatMessengerContactPhone(igsid), `fb:${igsid}`);
assert.equal(normalizeMessengerPsid(`ig:${igsid}`), '');
assert.equal(isInstagramPhone(`ig:${igsid}`), true);
assert.equal(isMessengerPhone(`fb:${igsid}`), true);
assert.equal(isInstagramSource('Instagram'), true);
assert.equal(isMessengerSource('Messenger'), true);
// Messenger heal must refuse Instagram-source bare rows (same digits ≠ claimable PSID).
assert.equal(isInstagramSource('Instagram') && !isMessengerPhone(igsid), true);

console.log('instagramContact.heal.check: ok');
