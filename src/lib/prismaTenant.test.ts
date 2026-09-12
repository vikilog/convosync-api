import { describe, expect, it } from 'vitest';
import { getTenantWorkspaceId, runWithTenant } from '../modules/identity/tenant-context.js';
import {
  applySoftDeleteWhere,
  applyTenantWhere,
  SOFT_DELETE_MODELS,
  TENANT_SCOPED_MODELS,
} from './prismaTenant.js';

describe('tenant isolation', () => {
  it('scopes tenant models to the bound workspace and not another', () => {
    const shapeA = runWithTenant('wsA', () =>
      applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()),
    );
    const shapeB = runWithTenant('wsB', () =>
      applyTenantWhere('Contact', { id: 'c1' }, getTenantWorkspaceId()),
    );
    expect(shapeA).toEqual({ id: 'c1', workspaceId: 'wsA' });
    expect(shapeB).toEqual({ id: 'c1', workspaceId: 'wsB' });
    expect(shapeA).not.toEqual(shapeB);
  });

  it('forces AND when a query already names a different workspaceId', () => {
    expect(applyTenantWhere('Contact', { workspaceId: 'wsB' }, 'wsA')).toEqual({
      AND: [{ workspaceId: 'wsB' }, { workspaceId: 'wsA' }],
    });
  });

  it('does not tenant-scope User (home workspace ≠ tenant)', () => {
    expect(TENANT_SCOPED_MODELS.has('User')).toBe(false);
    expect(applyTenantWhere('User', { email: 'a@b.co' }, 'wsA')).toEqual({ email: 'a@b.co' });
  });

  it('soft-deletes hide rows unless deletedAt is explicit', () => {
    expect(SOFT_DELETE_MODELS.has('Contact')).toBe(true);
    expect(applySoftDeleteWhere('Contact', { id: '1' })).toEqual({ id: '1', deletedAt: null });
    expect(applySoftDeleteWhere('Message', { id: '1' })).toEqual({ id: '1' });
  });

  it('restores ALS tenant after nested runWithTenant', () => {
    runWithTenant('wsA', () => {
      runWithTenant('wsB', () => {
        expect(getTenantWorkspaceId()).toBe('wsB');
      });
      expect(getTenantWorkspaceId()).toBe('wsA');
    });
    expect(getTenantWorkspaceId()).toBeUndefined();
  });
});
