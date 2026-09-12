import assert from 'node:assert/strict';
import { webWidgetUpdateSchema } from './webWidget.schemas.js';

assert.equal(webWidgetUpdateSchema.safeParse({}).success, true);
assert.equal(webWidgetUpdateSchema.safeParse({ botName: '' }).success, false);
assert.equal(webWidgetUpdateSchema.safeParse({ accentColor: 'green' }).success, false);
assert.equal(webWidgetUpdateSchema.safeParse({ accentColor: '#16a34a' }).success, true);
assert.equal(webWidgetUpdateSchema.safeParse({ agentId: null }).success, true);

console.log('webWidget.schemas.check.ts: ok');
