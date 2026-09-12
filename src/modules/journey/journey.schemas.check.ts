import assert from 'node:assert/strict';
import {
  createJourneySchema,
  saveGraphSchema,
  triggerJourneySchema,
  updateJourneySchema,
} from './journey.schemas.js';

assert.equal(createJourneySchema.safeParse({ name: 'Welcome' }).success, true);
assert.equal(createJourneySchema.safeParse({ name: '' }).success, false);
assert.equal(updateJourneySchema.safeParse({}).success, true);
assert.equal(updateJourneySchema.safeParse({ status: 'nope' }).success, false);
assert.equal(
  saveGraphSchema.safeParse({
    nodes: [{ id: 'n1', type: 'TRIGGER', data: {}, positionX: 0, positionY: 0 }],
    edges: [],
  }).success,
  true
);
assert.equal(saveGraphSchema.safeParse({ nodes: [], edges: [] }).success, true);
assert.equal(saveGraphSchema.safeParse({}).success, false);
assert.equal(
  triggerJourneySchema.safeParse({ event: 'manual', contactId: 'c1' }).success,
  true
);
assert.equal(triggerJourneySchema.safeParse({ event: 'manual' }).success, false);

console.log('journey.schemas.check.ts: ok');
