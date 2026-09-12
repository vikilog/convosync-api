import assert from 'node:assert/strict';
import {
  inAppNotificationActivityQuerySchema,
  inAppNotificationListQuerySchema,
} from './inAppNotifications.schemas.js';

assert.equal(inAppNotificationListQuerySchema.safeParse({}).success, true);
assert.equal(inAppNotificationListQuerySchema.safeParse({ limit: '0' }).success, false);
assert.equal(inAppNotificationActivityQuerySchema.safeParse({ limit: '20' }).success, true);
assert.equal(inAppNotificationActivityQuerySchema.safeParse({ limit: '99' }).success, false);

console.log('inAppNotifications.schemas.check.ts: ok');
