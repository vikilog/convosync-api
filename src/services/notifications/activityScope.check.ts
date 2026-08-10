import assert from 'node:assert/strict';
import { activityWhereForRole, normalizeActivityRole } from './activityScope.js';

assert.equal(normalizeActivityRole('admin'), 'admin');
assert.equal(normalizeActivityRole('owner'), 'agent');
assert.equal(normalizeActivityRole('agent'), 'agent');
assert.equal(normalizeActivityRole(undefined), 'agent');

const adminWhere = activityWhereForRole({
  workspaceId: 'ws1',
  userId: 'u1',
  role: 'admin',
});
assert.deepEqual(adminWhere, { workspaceId: 'ws1' });

const agentWhere = activityWhereForRole({
  workspaceId: 'ws1',
  userId: 'u1',
  role: 'agent',
});
assert.deepEqual(agentWhere, {
  workspaceId: 'ws1',
  OR: [{ actorUserId: 'u1' }, { targetUserId: 'u1' }],
});

console.log('activityScope.check.ts: ok');
