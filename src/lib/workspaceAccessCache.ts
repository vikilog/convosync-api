import { getRedis } from './redis.js';

// ponytail: caches DB-derived membership + subscription only. JWT verify, tokenVersion, and jti stay in authenticate().
// Deny is never cached (add-member must work on the next request). Redis down → Postgres, never allow.

/** Membership allow-list. TTL middle of the 60–300s plan range. */
export const WORKSPACE_ACCESS_TTL_SEC = 120;
/** Subscription write-gate. TTL middle of the 30–60s plan range. */
export const WORKSPACE_SUB_TTL_SEC = 45;
const REDIS_OP_TIMEOUT_MS = 800;

export type WorkspaceWriteGate = {
  isSuperAdmin: boolean;
  subscriptionStatus: string;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  planId: string | null;
};

export function workspaceAccessCacheKey(userId: string, workspaceId: string) {
  return `ws:access:${userId}:${workspaceId}`;
}

export function workspaceSubCacheKey(workspaceId: string) {
  return `ws:sub:${workspaceId}`;
}

export function serializeWriteGate(gate: WorkspaceWriteGate): string {
  return JSON.stringify(gate);
}

export function parseWriteGate(raw: string): WorkspaceWriteGate | null {
  try {
    const v = JSON.parse(raw) as Partial<WorkspaceWriteGate>;
    if (typeof v.isSuperAdmin !== 'boolean') return null;
    if (typeof v.subscriptionStatus !== 'string' || !v.subscriptionStatus) return null;
    if (v.trialStartedAt !== null && typeof v.trialStartedAt !== 'string') return null;
    if (v.trialEndsAt !== null && typeof v.trialEndsAt !== 'string') return null;
    if (v.planId !== null && typeof v.planId !== 'string') return null;
    return {
      isSuperAdmin: v.isSuperAdmin,
      subscriptionStatus: v.subscriptionStatus,
      trialStartedAt: v.trialStartedAt,
      trialEndsAt: v.trialEndsAt,
      planId: v.planId ?? null,
    };
  } catch {
    return null;
  }
}

async function withRedisTimeout<T>(op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis operation timed out')), REDIS_OP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `true` = cached allow. `null` = miss / Redis down (caller hits Postgres). Never caches deny. */
export async function getCachedWorkspaceAccess(
  userId: string,
  workspaceId: string
): Promise<true | null> {
  try {
    const raw = await withRedisTimeout(getRedis().get(workspaceAccessCacheKey(userId, workspaceId)));
    return raw === '1' ? true : null;
  } catch (err) {
    console.warn('[workspaceAccessCache] access read failed; falling back to Postgres', err);
    return null;
  }
}

export async function setCachedWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  try {
    await withRedisTimeout(
      getRedis().set(workspaceAccessCacheKey(userId, workspaceId), '1', 'EX', WORKSPACE_ACCESS_TTL_SEC)
    );
  } catch (err) {
    console.warn('[workspaceAccessCache] access write failed', err);
  }
}

export async function invalidateWorkspaceAccessCache(
  userId: string,
  workspaceId: string
): Promise<void> {
  try {
    await withRedisTimeout(getRedis().del(workspaceAccessCacheKey(userId, workspaceId)));
  } catch (err) {
    console.warn('[workspaceAccessCache] access invalidate failed', err);
  }
}

export async function getCachedWriteGate(workspaceId: string): Promise<WorkspaceWriteGate | null> {
  try {
    const raw = await withRedisTimeout(getRedis().get(workspaceSubCacheKey(workspaceId)));
    if (raw == null) return null;
    return parseWriteGate(raw);
  } catch (err) {
    console.warn('[workspaceAccessCache] sub read failed; falling back to Postgres', err);
    return null;
  }
}

export async function setCachedWriteGate(workspaceId: string, gate: WorkspaceWriteGate): Promise<void> {
  try {
    await withRedisTimeout(
      getRedis().set(workspaceSubCacheKey(workspaceId), serializeWriteGate(gate), 'EX', WORKSPACE_SUB_TTL_SEC)
    );
  } catch (err) {
    console.warn('[workspaceAccessCache] sub write failed', err);
  }
}

export async function invalidateWorkspaceSubscriptionCache(workspaceId: string): Promise<void> {
  try {
    await withRedisTimeout(getRedis().del(workspaceSubCacheKey(workspaceId)));
  } catch (err) {
    console.warn('[workspaceAccessCache] sub invalidate failed', err);
  }
}
