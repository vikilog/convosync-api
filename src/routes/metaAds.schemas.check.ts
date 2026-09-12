import assert from 'node:assert/strict';
import {
  metaAdsConnectBodySchema,
  metaAdsCtwaCreateBodySchema,
  metaAdsSelectAccountBodySchema,
} from './metaAds.schemas.js';

assert.equal(metaAdsSelectAccountBodySchema.safeParse({ adAccountId: 'act_1' }).success, true);
assert.equal(metaAdsConnectBodySchema.safeParse({ code: 'x' }).success, true);
assert.equal(
  metaAdsCtwaCreateBodySchema.safeParse({
    campaignName: 'A',
    dailyBudget: 10,
    startDate: '2026-01-01',
    headline: 'Hi',
  }).success,
  true
);
assert.equal(metaAdsCtwaCreateBodySchema.safeParse({ dailyBudget: '10' }).success, false);

console.log('metaAds.schemas.check.ts: ok');
