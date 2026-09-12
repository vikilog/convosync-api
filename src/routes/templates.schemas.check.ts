import assert from 'node:assert/strict';
import { templateBodySchema, templateUpdateSchema } from './templates.schemas.js';

assert.equal(
  templateBodySchema.safeParse({ name: 'hello', category: 'UTILITY', bodyPattern: 'Hi' }).success,
  true
);
assert.equal(templateBodySchema.safeParse({ name: 'hello' }).success, false);
assert.equal(templateUpdateSchema.safeParse({}).success, true);

console.log('templates.schemas.check.ts: ok');
