import assert from 'node:assert/strict';
import { applySoftDeleteWhere, applyTenantWhere, SOFT_DELETE_MODELS, TENANT_SCOPED_MODELS } from './prismaTenant.js';
import { getTenantWorkspaceId, runWithTenant } from '../modules/identity/tenant-context.js';

assert.equal(applySoftDeleteWhere('Message', { id: '1' })?.id, '1');
assert.deepEqual(applySoftDeleteWhere('Contact', { id: '1' }), { id: '1', deletedAt: null });
assert.deepEqual(applySoftDeleteWhere('Contact', { deletedAt: { not: null } }), { deletedAt: { not: null } });

assert.deepEqual(applyTenantWhere('Contact', undefined, 'wsA'), { workspaceId: 'wsA' });
assert.deepEqual(applyTenantWhere('Contact', { status: 'open' }, 'wsA'), { status: 'open', workspaceId: 'wsA' });
assert.deepEqual(applyTenantWhere('Contact', { workspaceId: 'wsA' }, 'wsA'), { workspaceId: 'wsA' });
assert.deepEqual(applyTenantWhere('Contact', { workspaceId: 'wsB' }, 'wsA'), {
  AND: [{ workspaceId: 'wsB' }, { workspaceId: 'wsA' }],
});
assert.deepEqual(applyTenantWhere('User', { email: 'a@b.co' }, 'wsA'), { email: 'a@b.co' });
assert.deepEqual(applyTenantWhere('Contact', { id: '1' }, undefined), { id: '1' });

assert.equal(SOFT_DELETE_MODELS.has('User'), true);
assert.equal(TENANT_SCOPED_MODELS.has('User'), false);
assert.equal(TENANT_SCOPED_MODELS.has('Contact'), true);

assert.equal(getTenantWorkspaceId(), undefined);
runWithTenant('wsA', () => {
  assert.equal(getTenantWorkspaceId(), 'wsA');
});
assert.equal(getTenantWorkspaceId(), undefined);

const shapeA = runWithTenant('wsA', () => applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()));
const shapeB = runWithTenant('wsB', () => applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()));
assert.deepEqual(shapeA, { id: 'c1', workspaceId: 'wsA' });
assert.deepEqual(shapeB, { id: 'c1', workspaceId: 'wsB' });
assert.notDeepEqual(shapeA, shapeB);
runWithTenant('wsA', () => {
  runWithTenant('wsB', () => {
    assert.deepEqual(applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()), shapeB);
  });
  assert.deepEqual(applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()), shapeA);
});

console.log('prismaTenant.check.ts: ok');
