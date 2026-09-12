import assert from 'node:assert/strict';
import { metaDataDeletionStatusQuerySchema } from './meta.schemas.js';

assert.equal(metaDataDeletionStatusQuerySchema.safeParse({}).success, true);
assert.equal(metaDataDeletionStatusQuerySchema.safeParse({ code: 'meta-1' }).success, true);
assert.equal(metaDataDeletionStatusQuerySchema.safeParse({ code: 1 }).success, false);

console.log('meta.schemas.check.ts: ok');
