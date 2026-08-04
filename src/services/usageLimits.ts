/**
 * Sentinel for "unlimited" in WorkspaceUsageLimits Int columns.
 * Must fit Postgres INT4 (signed 32-bit). Number.MAX_SAFE_INTEGER does not.
 */
export const UNLIMITED_USAGE_LIMIT = 2_147_483_647;

export function isUnlimitedUsageLimit(limit: number): boolean {
  return limit >= UNLIMITED_USAGE_LIMIT;
}
