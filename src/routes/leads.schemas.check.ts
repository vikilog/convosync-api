import assert from 'node:assert/strict';
import {
  leadCreateSchema,
  leadListQuerySchema,
  leadUpdateSchema,
} from './leads.schemas.js';

assert.equal(leadListQuerySchema.safeParse({}).success, true);
assert.equal(leadListQuerySchema.safeParse({ source: 'manual', funnelId: 'f1' }).success, true);
assert.equal(leadCreateSchema.safeParse({ funnelId: 'f1' }).success, true);
assert.equal(leadCreateSchema.safeParse({}).success, false);
assert.equal(leadUpdateSchema.safeParse({ name: null, email: null }).success, true);
assert.equal(leadUpdateSchema.safeParse({}).success, true);

console.log('leads.schemas.check.ts: ok');
