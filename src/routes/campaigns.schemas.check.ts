import assert from 'node:assert/strict';
import { campaignCreateSchema, campaignUpdateSchema } from './campaigns.schemas.js';

assert.equal(
  campaignCreateSchema.safeParse({ name: 'Hi', templateId: 't1', audienceType: 'all' }).success,
  true
);
assert.equal(campaignCreateSchema.safeParse({ name: 'Hi' }).success, false);
assert.equal(campaignUpdateSchema.safeParse({}).success, false);
assert.equal(campaignUpdateSchema.safeParse({ name: 'Renamed' }).success, true);

console.log('campaigns.schemas.check.ts: ok');
