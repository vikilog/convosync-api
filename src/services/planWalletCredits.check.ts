/**
 * ponytail: self-check for plan-included CC parsing and period amounts.
 * Run: npx tsx src/services/planWalletCredits.check.ts
 */
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_SEEDS, parsePlanWalletCreditsCc } from './subscriptionPlans.ts';
import { planIncludedCreditPaise } from './wallet.service.ts';

const starter = DEFAULT_PLAN_SEEDS[0]!.features;
const growth = DEFAULT_PLAN_SEEDS[1]!.features;
const business = DEFAULT_PLAN_SEEDS[2]!.features;

assert.equal(parsePlanWalletCreditsCc(starter.walletCredits), 200);
assert.equal(parsePlanWalletCreditsCc(growth.walletCredits), 750);
assert.equal(parsePlanWalletCreditsCc(business.walletCredits), 2500);
assert.equal(parsePlanWalletCreditsCc('2,500 CC'), 2500);
assert.equal(parsePlanWalletCreditsCc('Custom'), null);
assert.equal(planIncludedCreditPaise(starter, 'monthly'), 20_000);
assert.equal(planIncludedCreditPaise(starter, 'annual'), 240_000);

console.log('planWalletCredits.check: ok');
