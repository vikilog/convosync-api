/**
 * ponytail: tiny self-check for plan gates (no test framework).
 * Run: npx tsx src/services/planUsageGuards.check.ts
 */
import {
  channelTypeAllowedByPlan,
  DEFAULT_PLAN_SEEDS,
  mediaGalleryAllowedByPlan,
  planFeatureEnabled,
  storageLimitBytesFromPlan,
} from './subscriptionPlans.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const starter = DEFAULT_PLAN_SEEDS[0]!.features;
const growth = DEFAULT_PLAN_SEEDS[1]!.features;
const business = DEFAULT_PLAN_SEEDS[2]!.features;
const enterprise = DEFAULT_PLAN_SEEDS[3]!.features;

assert(channelTypeAllowedByPlan(starter, 'whatsapp'), 'starter whatsapp');
assert(!channelTypeAllowedByPlan(starter, 'instagram'), 'starter no instagram');
assert(!channelTypeAllowedByPlan(starter, 'messenger'), 'starter no messenger');
assert(channelTypeAllowedByPlan(starter, 'email'), 'starter email allowed');
assert(!channelTypeAllowedByPlan(starter, 'instagram'), 'starter blocks instagram not email');

assert(channelTypeAllowedByPlan(growth, 'instagram'), 'growth instagram');
assert(channelTypeAllowedByPlan(growth, 'email'), 'growth email');
assert(!channelTypeAllowedByPlan(growth, 'messenger'), 'growth no messenger');

assert(channelTypeAllowedByPlan(business, 'messenger'), 'business messenger');
assert(planFeatureEnabled(business, 'socialListening'), 'business social listening');
assert(!planFeatureEnabled(growth, 'socialListening'), 'growth no social listening');

assert(channelTypeAllowedByPlan(enterprise, 'messenger'), 'enterprise messenger');
assert(planFeatureEnabled(enterprise, 'ctwaAds'), 'enterprise ctwa');

assert(starter.storageGb === 0, 'starter storage 0');
assert(growth.storageGb === 1, 'growth storage 1');
assert(business.storageGb === 5, 'business storage 5');
assert(enterprise.storageGb == null, 'enterprise storage custom (omitted)');

assert(!mediaGalleryAllowedByPlan(starter), 'starter no media gallery');
assert(mediaGalleryAllowedByPlan(growth), 'growth media gallery');
assert(mediaGalleryAllowedByPlan(business), 'business media gallery');
assert(mediaGalleryAllowedByPlan(enterprise), 'enterprise media gallery custom');

assert(storageLimitBytesFromPlan(starter) === 0, 'starter limit 0 bytes');
assert(storageLimitBytesFromPlan(growth) === 1024 ** 3, 'growth limit 1 GiB');
assert(storageLimitBytesFromPlan(business) === 5 * 1024 ** 3, 'business limit 5 GiB');
assert(storageLimitBytesFromPlan(enterprise) === null, 'enterprise limit custom');

console.log('planUsageGuards.check: ok');
