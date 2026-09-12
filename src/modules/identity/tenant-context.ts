import { AsyncLocalStorage } from 'node:async_hooks';

type TenantStore = { workspaceId: string };

const tenantAls = new AsyncLocalStorage<TenantStore>();

export function getTenantWorkspaceId(): string | undefined {
  return tenantAls.getStore()?.workspaceId;
}

/** Bind JWT workspace for the rest of this request. Workers leave ALS empty (no inject). */
export function bindTenantWorkspace(workspaceId: string): void {
  tenantAls.enterWith({ workspaceId });
}

export function runWithTenant<T>(workspaceId: string, fn: () => T): T {
  return tenantAls.run({ workspaceId }, fn);
}
