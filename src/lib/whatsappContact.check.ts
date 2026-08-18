/**
 * Run: npx tsx src/lib/whatsappContact.check.ts
 */
import assert from 'node:assert/strict';
import {
  phonesMatch,
  whatsappCanonicalDigits,
  whatsappInboxPhoneKey,
} from './whatsappContact.js';

// India +91 vs bare local 10-digit form must still collapse (documented intent).
assert.equal(whatsappCanonicalDigits('919876543210'), '9876543210');
assert.equal(whatsappCanonicalDigits('9876543210'), '9876543210');
assert.equal(whatsappInboxPhoneKey('919876543210'), whatsappInboxPhoneKey('9876543210'));
assert.equal(phonesMatch('+919876543210', '9876543210'), true);

// Two DIFFERENT-country numbers that happen to share the same trailing 10
// digits must NOT collapse — this was the data-loss bug: an unrelated
// contact's row could get merged (and deleted) into the wrong contact.
const usNumber = '12125550147'; // +1 212 555 0147 (11 digits)
const otherCountryNumber = '442125550147'; // +44 ...5550147 (12 digits, same trailing 10)
assert.notEqual(whatsappCanonicalDigits(usNumber), whatsappCanonicalDigits(otherCountryNumber));
assert.equal(phonesMatch(usNumber, otherCountryNumber), false);

// A non-91, non-10-digit number canonicalizes to itself (no truncation).
assert.equal(whatsappCanonicalDigits('12125550147'), '12125550147');
assert.equal(whatsappCanonicalDigits('442125550147'), '442125550147');

// Empty/garbage input.
assert.equal(whatsappCanonicalDigits(''), '');
assert.equal(whatsappCanonicalDigits('abc'), '');

console.log('whatsappContact.check.ts: ok');
