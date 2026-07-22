/**
 * ponytail: runnable check for wallet token billing math.
 * Run: npx tsx backend/src/services/workspaceTokenUsage.check.ts
 */
import { emailBillableSends, incrementalIncludedBillable } from './usageCost.constants.js';
import {
  allocateAiLineCosts,
  computeTokenBillingCosts,
} from './workspaceTokenUsage.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const payg = computeTokenBillingCosts({ used: 10_000, costInr: 13.5, includedTokens: 0 });
assert(payg.billedCostInr === 13.5, `payg billed expected 13.5 got ${payg.billedCostInr}`);
assert(payg.includedCreditInr === 0, `payg credit expected 0 got ${payg.includedCreditInr}`);

// includedTokens is wallet credit (same unit as costInr), not raw LLM tokens
const withIncluded = computeTokenBillingCosts({
  used: 64_384,
  costInr: 1.23,
  includedTokens: 500,
});
assert(withIncluded.includedCreditInr === 1.23, `credit should equal charge, got ${withIncluded.includedCreditInr}`);
assert(withIncluded.billedCostInr === 0, `billed should be 0 under credit, got ${withIncluded.billedCostInr}`);

const overCredit = computeTokenBillingCosts({ costInr: 12.5, includedTokens: 5 });
assert(overCredit.includedCreditInr === 5, `credit cap expected 5 got ${overCredit.includedCreditInr}`);
assert(overCredit.billedCostInr === 7.5, `overage billed expected 7.5 got ${overCredit.billedCostInr}`);

const lines = allocateAiLineCosts({
  inputTokens: 58_584,
  outputTokens: 2_230,
  rawCostInr: 0.86,
});
const lineSum = Math.round((lines.inputCostInr + lines.outputCostInr) * 10000) / 10000;
assert(lineSum === 0.86, `line costs must sum to rawCostInr, got ${lineSum}`);

// 1 CC = 1 email; included covers sends before wallet debit
assert(
  emailBillableSends({ sentBefore: 0, sendCount: 3, emailsIncluded: 1000 }) === 0,
  'emails within included should not bill'
);
assert(
  emailBillableSends({ sentBefore: 998, sendCount: 5, emailsIncluded: 1000 }) === 3,
  'only overage emails bill'
);
const emailCharge = computeTokenBillingCosts({ costInr: 12, includedTokens: 10 });
assert(emailCharge.billedCostInr === 2, `email overage expected 2 got ${emailCharge.billedCostInr}`);

// Wallet only debits the slice past included credit
assert(
  incrementalIncludedBillable({ mtdGrossBefore: 0, thisCharge: 1.23, includedCredit: 500 }) === 0,
  'AI under included credit should not debit wallet'
);
assert(
  incrementalIncludedBillable({ mtdGrossBefore: 498, thisCharge: 5, includedCredit: 500 }) === 3,
  'AI overage slice should debit wallet'
);

console.log('workspaceTokenUsage.check: ok');
