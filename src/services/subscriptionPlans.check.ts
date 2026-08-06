import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN_SEEDS,
  isCustomPlanSlug,
  planDisplayName,
  serializeSubscriptionPlan,
} from './subscriptionPlans.ts';

assert.equal(isCustomPlanSlug('custom-acme'), true);
assert.equal(isCustomPlanSlug('starter'), false);
assert.equal(planDisplayName('custom-acme-corp'), 'Acme Corp');
assert.equal(planDisplayName('starter'), 'Starter');

// PlanFeatureFlags UI gates need top-level channels (not only nested features.channels)
const businessSeed = DEFAULT_PLAN_SEEDS.find((p) => p.slug === 'business')!;
const serialized = serializeSubscriptionPlan({
  id: 'plan_biz',
  slug: businessSeed.slug,
  planCode: businessSeed.planCode,
  name: businessSeed.name,
  labelColor: businessSeed.labelColor,
  priceMonthly: businessSeed.priceMonthly,
  priceAnnual: businessSeed.priceAnnual,
  priceMonthlyPaise: businessSeed.priceMonthlyPaise,
  priceAnnualPaise: businessSeed.priceAnnualPaise,
  razorpayPlanIdMonthly: null,
  razorpayPlanIdAnnual: null,
  priceLabel: null,
  popular: true,
  borderColor: businessSeed.borderColor ?? null,
  editButtonStyle: businessSeed.editButtonStyle,
  sortOrder: businessSeed.sortOrder,
  trialDays: businessSeed.trialDays,
  features: businessSeed.features,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as Parameters<typeof serializeSubscriptionPlan>[0]);
assert.equal(serialized.channels, 'WhatsApp + Instagram + Messenger');
assert.equal(serialized.features.channels, serialized.channels);

console.log('subscriptionPlans custom slug check ok');
