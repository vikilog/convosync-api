/**
 * ponytail: CC→paise mapping for manual wallet credits.
 * Run: npx tsx backend/src/services/platformWalletCredit.check.ts
 */
import assert from 'node:assert/strict';
import { ccToDebitPaise } from './usageCost.constants.js';

assert.equal(ccToDebitPaise(1), 100);
assert.equal(ccToDebitPaise(100), 10_000);
assert.equal(ccToDebitPaise(500), 50_000);

console.log('platformWalletCredit.check.ts: ok');
