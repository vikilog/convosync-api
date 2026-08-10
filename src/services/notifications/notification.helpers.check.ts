import assert from 'node:assert/strict';
import {
  formatNotificationRelativeTime,
  mapTypeToCategory,
  mapTypeToSeverity,
} from './notification.helpers.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPES } from './types.js';

assert.equal(mapTypeToCategory(NOTIFICATION_TYPES.CAMPAIGN_COMPLETED), NOTIFICATION_CATEGORIES.CAMPAIGNS);
assert.equal(mapTypeToCategory(NOTIFICATION_TYPES.WALLET_BALANCE_LOW), NOTIFICATION_CATEGORIES.WALLET);
assert.equal(mapTypeToCategory(NOTIFICATION_TYPES.CONTACT_IMPORT_FINISHED), NOTIFICATION_CATEGORIES.IMPORTS);
assert.equal(mapTypeToCategory(NOTIFICATION_TYPES.TEAM_MEMBER_ADDED), NOTIFICATION_CATEGORIES.SETTINGS);
assert.equal(mapTypeToCategory('unknown_future_type'), NOTIFICATION_CATEGORIES.SYSTEM);

assert.equal(mapTypeToSeverity(NOTIFICATION_TYPES.TEMPLATE_APPROVED), 'success');
assert.equal(mapTypeToSeverity(NOTIFICATION_TYPES.TEMPLATE_REJECTED), 'failure');
assert.equal(mapTypeToSeverity(NOTIFICATION_TYPES.WALLET_BALANCE_LOW), 'warning');
assert.equal(mapTypeToSeverity(NOTIFICATION_TYPES.TEAM_MEMBER_ADDED), 'success');
assert.equal(mapTypeToSeverity('unknown_future_type'), 'info');

const now = Date.parse('2026-08-10T12:00:00.000Z');
assert.equal(formatNotificationRelativeTime(now, now), 'Just now');
assert.equal(formatNotificationRelativeTime(now - 90_000, now), '1m ago');
assert.equal(formatNotificationRelativeTime(now - 3_600_000 * 2, now), '2h ago');
assert.equal(formatNotificationRelativeTime(now - 86_400_000 * 3, now), '3d ago');

console.log('notification.helpers.check.ts: ok');
