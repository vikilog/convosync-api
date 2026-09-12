import assert from 'node:assert/strict';
import {
  funnelPatchSchema,
  funnelStageWriteSchema,
  funnelWriteSchema,
} from './leadFunnels.schemas.js';

assert.equal(funnelWriteSchema.safeParse({ name: 'Sales' }).success, true);
assert.equal(funnelWriteSchema.safeParse({ name: '  ' }).success, false);
assert.equal(funnelWriteSchema.safeParse({}).success, false);
assert.equal(funnelPatchSchema.safeParse({}).success, true);
assert.equal(funnelPatchSchema.safeParse({ name: '' }).success, false);
assert.equal(funnelStageWriteSchema.safeParse({ name: 'New', isFinal: false }).success, true);
assert.equal(funnelStageWriteSchema.safeParse({ name: '' }).success, false);

console.log('leadFunnels.schemas.check.ts: ok');
