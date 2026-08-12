/**
 * Run: npx tsx src/services/billingCurrency.check.ts
 */
import assert from 'node:assert/strict';
import {
  countryToCurrency,
  normalizeCountryCode,
  planAmountMinor,
  toMinorUnits,
} from './billingCurrency.ts';

assert.equal(normalizeCountryCode('IN'), 'IN');
assert.equal(normalizeCountryCode('in'), 'IN');
assert.equal(normalizeCountryCode('IND'), 'IN');
assert.equal(normalizeCountryCode('India'), 'IN');
assert.equal(normalizeCountryCode('US'), 'US');
assert.equal(normalizeCountryCode(null), 'IN');

assert.equal(countryToCurrency('IN'), 'INR');
assert.equal(countryToCurrency('India'), 'INR');
assert.equal(countryToCurrency('US'), 'USD');
assert.equal(countryToCurrency('GB'), 'USD');
assert.equal(countryToCurrency('AE'), 'USD');

assert.equal(toMinorUnits(29), 2900);
assert.equal(toMinorUnits(1999), 199_900);

const plan = {
  priceMonthlyPaise: 199_900,
  priceAnnualPaise: 1_999_000,
  priceMonthlyCents: 2900,
  priceAnnualCents: 29_000,
};
assert.equal(planAmountMinor(plan, 'monthly', 'INR'), 199_900);
assert.equal(planAmountMinor(plan, 'monthly', 'USD'), 2900);
assert.equal(planAmountMinor(plan, 'annual', 'USD'), 29_000);
assert.equal(planAmountMinor({ ...plan, priceMonthlyCents: null }, 'monthly', 'USD'), null);

console.log('billingCurrency check ok');
