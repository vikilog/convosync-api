import assert from 'node:assert/strict';
import {
  createIgJourneySchema,
  saveIgGraphSchema,
  updateIgJourneySchema,
} from './ig-journey.schemas.js';

assert.equal(createIgJourneySchema.safeParse({ name: 'IG welcome' }).success, true);
assert.equal(createIgJourneySchema.safeParse({ name: '' }).success, false);
assert.equal(updateIgJourneySchema.safeParse({}).success, true);
assert.equal(updateIgJourneySchema.safeParse({ status: 'nope' }).success, false);
assert.equal(saveIgGraphSchema.safeParse({ nodes: [], edges: [] }).success, true);
assert.equal(saveIgGraphSchema.safeParse({}).success, false);

console.log('ig-journey.schemas.check.ts: ok');
