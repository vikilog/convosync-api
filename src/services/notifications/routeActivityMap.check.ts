import assert from 'node:assert/strict';
import {
  listMappedRouteKeys,
  patternToRegex,
  resolveRouteActivity,
  ROUTE_ACTIVITY,
} from './routeActivityMap.js';
import { NOTIFICATION_TYPES, forBellForType } from './types.js';

// Pattern matching
assert.equal(patternToRegex('/api/campaigns/:id/send').test('/api/campaigns/abc/send'), true);
assert.equal(patternToRegex('/api/campaigns/:id/send').test('/api/campaigns/abc'), false);
assert.equal(patternToRegex('/api/contacts').test('/api/contacts'), true);

// Mapped send → campaign_send, actor entity from params
const send = resolveRouteActivity({
  method: 'POST',
  urlPath: '/api/campaigns/camp_1/send',
  routePattern: '/:id/send',
  params: { id: 'camp_1' },
});
assert.ok(send);
assert.equal(send!.type, NOTIFICATION_TYPES.CAMPAIGN_SEND);
assert.equal(send!.entityId, 'camp_1');
assert.equal(send!.forBell, false);

// Explicit skip (rich emit elsewhere)
assert.equal(
  resolveRouteActivity({
    method: 'POST',
    urlPath: '/api/contacts/import',
    routePattern: '/import',
  }),
  null
);

// Platform / webhook skipped
assert.equal(
  resolveRouteActivity({ method: 'POST', urlPath: '/api/platform/organizations/x/activate' }),
  null
);
assert.equal(
  resolveRouteActivity({ method: 'POST', urlPath: '/api/webhook/whatsapp' }),
  null
);

// GET never emits
assert.equal(
  resolveRouteActivity({ method: 'GET', urlPath: '/api/campaigns' }),
  null
);

// Team chat send
const chat = resolveRouteActivity({
  method: 'POST',
  urlPath: '/api/team-chat/messages',
  routePattern: '/messages',
});
assert.ok(chat);
assert.equal(chat!.type, NOTIFICATION_TYPES.TEAM_CHAT_MESSAGE);

// Bell defaults for alert types
assert.equal(forBellForType(NOTIFICATION_TYPES.TEAM_MEMBER_ADDED), true);
assert.equal(forBellForType(NOTIFICATION_TYPES.CAMPAIGN_CREATED), false);
assert.equal(forBellForType(NOTIFICATION_TYPES.PAYMENT_SUCCESS), true);

// Inventory coverage smoke: SideNav-critical areas present
const keys = listMappedRouteKeys();
const mustInclude = [
  'POST /api/campaigns',
  'POST /api/campaigns/:id/send',
  'POST /api/templates',
  'POST /api/contacts',
  'POST /api/conversations/:id/messages',
  'POST /api/team-chat/messages',
  'POST /api/journeys',
  'POST /api/agents',
  'POST /api/leads',
  'POST /api/media-gallery',
  'POST /api/whatsapp/connect',
  'POST /api/billing/order/create',
  'PATCH /api/workspace/company',
  'POST /api/social-listening/comments/:id/action',
];
for (const k of mustInclude) {
  assert.ok(k in ROUTE_ACTIVITY, `missing map entry: ${k}`);
  assert.ok(keys.includes(k), `listMapped missing: ${k}`);
}

console.log(`routeActivityMap.check.ts: ok (${keys.length} mapped routes)`);
