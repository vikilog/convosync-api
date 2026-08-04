/**
 * Runnable check: plan create forces Unlimited contacts + slug kind rules.
 * Run: npx tsx src/services/subscriptionPlans.planCreate.check.ts
 */
import assert from 'node:assert/strict';
import {
  channelsLimitFromLabel,
  campaignsLimitFromFeatures,
  DEFAULT_PLAN_SEEDS,
  isCustomPlanSlug,
  normalizePlanFeatures,
  planSlugBase,
  provisionRazorpayPlanIds,
  slugifyPlanName,
} from './subscriptionPlans.js';
import { UNLIMITED_USAGE_LIMIT } from './usageLimits.js';

assert.equal(
  normalizePlanFeatures({
    contacts: '2,000',
    teamMembers: '3',
    aiAgents: '1',
    channels: 'WhatsApp only',
  }).contacts,
  'Unlimited'
);

assert.equal(slugifyPlanName('Micro Plan'), 'micro-plan');
assert.equal(planSlugBase('Growth', 'public'), 'growth');
assert.equal(planSlugBase('Growth', 'custom'), 'custom-growth');
assert.equal(isCustomPlanSlug(planSlugBase('Enterprise Deal', 'custom')), true);
assert.equal(isCustomPlanSlug(planSlugBase('Scale', 'public')), false);
assert.equal(channelsLimitFromLabel('WhatsApp only'), 1);
assert.equal(channelsLimitFromLabel('WhatsApp + Instagram'), 2);
assert.equal(channelsLimitFromLabel('WhatsApp + Instagram + Messenger'), 3);
assert.equal(channelsLimitFromLabel('All + priority setup'), UNLIMITED_USAGE_LIMIT);
assert.ok(UNLIMITED_USAGE_LIMIT <= 2_147_483_647);

const noRp = await provisionRazorpayPlanIds(
  {
    id: 'x',
    name: 'TEST',
    slug: 'test',
    priceMonthly: 1999,
    priceAnnual: 19990,
    priceMonthlyPaise: 199_900,
    priceAnnualPaise: 1_999_000,
  },
  null
);
assert.equal(noRp.razorpayPlanIdMonthly, null);
assert.ok(noRp.warnings.length > 0);

assert.equal(DEFAULT_PLAN_SEEDS[0]!.features.storageGb, 0);
assert.equal(DEFAULT_PLAN_SEEDS[1]!.features.storageGb, 1);
assert.equal(DEFAULT_PLAN_SEEDS[2]!.features.storageGb, 5);
assert.equal(DEFAULT_PLAN_SEEDS[3]!.features.storageGb, undefined);
assert.equal(campaignsLimitFromFeatures(DEFAULT_PLAN_SEEDS[0]!.features), UNLIMITED_USAGE_LIMIT);
assert.equal(campaignsLimitFromFeatures({ ...DEFAULT_PLAN_SEEDS[0]!.features, campaigns: 5 }), 5);

console.log('subscriptionPlans.planCreate check ok');
