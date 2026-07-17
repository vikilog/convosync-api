/**
 * ponytail: runnable check for wallet token billing math.
 * Run: npx tsx backend/src/services/workspaceTokenUsage.check.ts
 */
import { computeTokenBillingCosts } from './workspaceTokenUsage.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const payg = computeTokenBillingCosts({ used: 10_000, costInr: 13.5, includedTokens: 0 });
assert(payg.billedCostInr === 13.5, `payg billed expected 13.5 got ${payg.billedCostInr}`);
assert(payg.includedCreditInr === 0, `payg credit expected 0 got ${payg.includedCreditInr}`);

const withIncluded = computeTokenBillingCosts({
  used: 10_000,
  costInr: 13.5,
  includedTokens: 5_000,
});
assert(withIncluded.billedCostInr < 13.5, 'included credit should reduce billed amount');
assert(withIncluded.includedCreditInr > 0, 'included credit should be > 0');

console.log('workspaceTokenUsage.check: ok');
