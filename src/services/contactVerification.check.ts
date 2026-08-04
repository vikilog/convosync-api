/**
 * Runnable self-check (no DB / Redis / Meta).
 *   npx tsx src/services/contactVerification.check.ts
 */
import assert from 'node:assert/strict';
import {
  generateOtpCode,
  hashOtpCode,
  isVerificationTarget,
  maskEmail,
  maskPhone,
  normalizeVerificationPhone,
  otpHashesMatch,
} from './contactVerification.service.js';

const code = generateOtpCode();
assert.match(code, /^\d{6}$/);
assert.equal(otpHashesMatch(hashOtpCode(code), code), true);
assert.equal(otpHashesMatch(hashOtpCode(code), '000000'), false);

assert.equal(normalizeVerificationPhone('+91 98765 43210'), '919876543210');
assert.equal(isVerificationTarget('company_email'), true);
assert.equal(isVerificationTarget('user_phone'), false);

assert.equal(maskEmail('priya@example.com'), 'pr***@example.com');
assert.ok(maskPhone('919876543210').endsWith('3210'));

console.log('contactVerification.check.ts: ok');
