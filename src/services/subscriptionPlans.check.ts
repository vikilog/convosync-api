import assert from 'node:assert/strict';
import { isCustomPlanSlug, planDisplayName } from './subscriptionPlans.ts';

assert.equal(isCustomPlanSlug('custom-acme'), true);
assert.equal(isCustomPlanSlug('starter'), false);
assert.equal(planDisplayName('custom-acme-corp'), 'Acme Corp');
assert.equal(planDisplayName('starter'), 'Starter');

console.log('subscriptionPlans custom slug check ok');
