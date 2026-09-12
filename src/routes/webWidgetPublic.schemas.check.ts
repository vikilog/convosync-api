import assert from 'node:assert/strict';
import { chatSchema, widgetConfigQuerySchema } from './webWidgetPublic.schemas.js';

assert.equal(widgetConfigQuerySchema.safeParse({ token: 'wgt_abc' }).success, true);
assert.equal(widgetConfigQuerySchema.safeParse({}).success, false);
assert.equal(widgetConfigQuerySchema.safeParse({ token: '' }).success, false);

assert.equal(chatSchema.safeParse({ token: 't', message: 'hi' }).success, true);
assert.equal(chatSchema.safeParse({ token: '', message: 'hi' }).success, false);
assert.equal(chatSchema.safeParse({ token: 't', message: '' }).success, false);
assert.equal(
  chatSchema.safeParse({ token: 't', message: 'hi', history: [{ role: 'user', content: 'x' }] })
    .success,
  true
);
assert.equal(
  chatSchema.safeParse({ token: 't', message: 'hi', history: [{ role: 'system', content: 'x' }] })
    .success,
  false
);

console.log('webWidgetPublic.schemas.check.ts: ok');
