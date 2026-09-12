import assert from 'node:assert/strict';
import { cannedCreateSchema, cannedUpdateSchema } from './canned-responses.schemas.js';

assert.equal(cannedCreateSchema.safeParse({ title: 'Hi', content: 'Hello' }).success, true);
assert.equal(cannedCreateSchema.safeParse({ title: '', content: 'Hello' }).success, false);
assert.equal(cannedUpdateSchema.safeParse({}).success, true);
assert.equal(cannedUpdateSchema.safeParse({ title: 'Renamed' }).success, true);

console.log('canned-responses.schemas.check.ts: ok');
