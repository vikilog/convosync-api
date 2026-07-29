/**
 * ponytail: tiny self-check for funnel automation gate.
 * Run: npx tsx src/services/leadFunnel.gate.check.ts
 */
import assert from 'node:assert/strict';
import { automationAllowed } from './leadFunnel.gate.js';

assert.equal(automationAllowed(null), false);
assert.equal(automationAllowed(''), false);
assert.equal(automationAllowed('fun_123'), true);

console.log('leadFunnel.gate.check: ok');
