/**
 * Runnable check: percent + max-cap discount math.
 * Run: npx tsx src/services/discountCoupons.check.ts
 */
import assert from 'node:assert/strict';
import {
  computeDiscountPaise,
  computeFinalAmountPaise,
  countUniqueWorkspacesByCoupon,
  deriveCouponStatus,
  couponBonusIdempotencyKey,
  isCouponApplicableToPlan,
  MIN_CHECKOUT_AMOUNT_PAISE,
  normalizeApplicablePlanSlugs,
  normalizeCouponCode,
  parseCouponCodeFromInvoiceDescription,
} from './discountCoupons.js';

assert.equal(normalizeCouponCode('  welcome20 '), 'WELCOME20');
assert.equal(parseCouponCodeFromInvoiceDescription('Starter plan (monthly) · WELCOME'), 'WELCOME');
assert.equal(parseCouponCodeFromInvoiceDescription('Starter plan (monthly)'), null);

// 20% of ₹1000 = ₹200
assert.equal(computeDiscountPaise(100_000, 20, null), 20_000);
// 20% of ₹1000 capped at ₹150
assert.equal(computeDiscountPaise(100_000, 20, 15_000), 15_000);
// 0% → no discount
assert.equal(computeDiscountPaise(100_000, 0, 15_000), 0);

assert.equal(MIN_CHECKOUT_AMOUNT_PAISE, 100);
// ₹12,999 plan, 100% off → charge ₹1 (not ₹0 / ₹0.01)
const plan12999Paise = 1_299_900;
const fullOff = computeDiscountPaise(plan12999Paise, 100, null);
assert.equal(fullOff, plan12999Paise);
assert.equal(computeFinalAmountPaise(plan12999Paise, fullOff), 100);
// partial discount above floor passes through
assert.equal(computeFinalAmountPaise(plan12999Paise, 500_000), plan12999Paise - 500_000);

const now = new Date('2026-06-15T12:00:00Z');
assert.equal(
  deriveCouponStatus(
    {
      isActive: true,
      validFrom: new Date('2026-01-01'),
      validUntil: new Date('2026-12-31'),
      maxRedemptions: 10,
      redemptionCount: 3,
    },
    now
  ),
  'active'
);
assert.equal(
  deriveCouponStatus(
    {
      isActive: false,
      validFrom: new Date('2026-01-01'),
      validUntil: new Date('2026-12-31'),
      maxRedemptions: 10,
      redemptionCount: 0,
    },
    now
  ),
  'paused'
);

const uniqueCounts = countUniqueWorkspacesByCoupon([
  { couponId: 'c1', workspaceId: 'w1' },
  { couponId: 'c1', workspaceId: 'w1' },
  { couponId: 'c1', workspaceId: 'w2' },
  { couponId: 'c2', workspaceId: 'w1' },
]);
assert.equal(uniqueCounts.get('c1'), 2);
assert.equal(uniqueCounts.get('c2'), 1);
assert.equal(uniqueCounts.get('missing'), undefined);

assert.deepEqual(normalizeApplicablePlanSlugs([' Starter ', 'growth', 'starter']), [
  'starter',
  'growth',
]);
assert.throws(() => normalizeApplicablePlanSlugs(['enterprise']), /Invalid plan slug/);

assert.equal(isCouponApplicableToPlan({ applicablePlanSlugs: [] }, 'starter'), true);
assert.equal(isCouponApplicableToPlan({ applicablePlanSlugs: ['starter'] }, 'starter'), true);
assert.equal(isCouponApplicableToPlan({ applicablePlanSlugs: ['starter'] }, 'growth'), false);
assert.equal(isCouponApplicableToPlan({ applicablePlanSlugs: ['starter'] }, 'business'), false);
assert.equal(
  isCouponApplicableToPlan({ applicablePlanSlugs: ['starter', 'growth'] }, 'business'),
  false
);
assert.equal(
  isCouponApplicableToPlan({ applicablePlanSlugs: ['starter', 'growth'] }, 'growth'),
  true
);

assert.equal(couponBonusIdempotencyKey('inv_abc'), 'coupon-bonus:inv_abc');

console.log('discountCoupons check ok');
