/**
 * ponytail: self-check for server idempotency key time-window bucketing.
 * Run: npx tsx src/modules/billing/paymentIntent.idempotency.check.ts
 */
import assert from 'node:assert/strict';

const IDEMPOTENCY_WINDOW_MS = 120_000;

function buildServerIdempotencyKey(workspaceId: string, purposeKey: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / IDEMPOTENCY_WINDOW_MS);
  return `${workspaceId}:${purposeKey}:${bucket}`;
}

const a = buildServerIdempotencyKey('ws1', 'wallet_topup:10000', 0);
const b = buildServerIdempotencyKey('ws1', 'wallet_topup:10000', IDEMPOTENCY_WINDOW_MS - 1);
const c = buildServerIdempotencyKey('ws1', 'wallet_topup:10000', IDEMPOTENCY_WINDOW_MS);
assert.equal(a, b, 'same window must collide');
assert.notEqual(a, c, 'next window must differ');
console.log('paymentIntent.idempotency.check: ok');
