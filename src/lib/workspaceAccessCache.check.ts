import assert from 'node:assert/strict';
import {
  parseWriteGate,
  serializeWriteGate,
  workspaceAccessCacheKey,
  workspaceSubCacheKey,
  WORKSPACE_ACCESS_TTL_SEC,
  WORKSPACE_SUB_TTL_SEC,
} from './workspaceAccessCache.js';

assert.equal(workspaceAccessCacheKey('u1', 'w1'), 'ws:access:u1:w1');
assert.equal(workspaceSubCacheKey('w1'), 'ws:sub:w1');
assert.ok(WORKSPACE_ACCESS_TTL_SEC >= 60 && WORKSPACE_ACCESS_TTL_SEC <= 300);
assert.ok(WORKSPACE_SUB_TTL_SEC >= 30 && WORKSPACE_SUB_TTL_SEC <= 60);

const gate = {
  isSuperAdmin: false,
  subscriptionStatus: 'trial',
  trialStartedAt: '2026-01-01T00:00:00.000Z',
  trialEndsAt: '2026-01-15T00:00:00.000Z',
  planId: null,
};
assert.deepEqual(parseWriteGate(serializeWriteGate(gate)), gate);
assert.equal(parseWriteGate('not-json'), null);
assert.equal(parseWriteGate('{"subscriptionStatus":"active"}'), null);
assert.equal(parseWriteGate('{"isSuperAdmin":true,"subscriptionStatus":""}'), null);

console.log('workspaceAccessCache.check.ts: ok');
