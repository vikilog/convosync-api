import assert from 'node:assert/strict';
import { contactCreateSchema, contactImportSchema } from './contacts.schemas.js';

assert.equal(contactCreateSchema.safeParse({ name: 'A', phone: '12345' }).success, true);
assert.equal(contactCreateSchema.safeParse({ name: 'A', phone: '12' }).success, false);
assert.equal(contactImportSchema.safeParse({ contacts: [] }).success, false);
assert.equal(
  contactImportSchema.safeParse({ contacts: [{ name: 'A', phone: '12345' }] }).success,
  true
);

console.log('contacts.schemas.check.ts: ok');
