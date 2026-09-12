/**
 * Run: npx tsx src/services/plivoVoicePricing.check.ts
 */
import assert from 'node:assert/strict';
import { voiceRatePerMinuteUsd } from './plivoVoicePricing.js';

assert.equal(voiceRatePerMinuteUsd('0.0095'), 0.0095);
assert.equal(voiceRatePerMinuteUsd('0.0075', 60), 0.0075);
assert.equal(voiceRatePerMinuteUsd('0.01', 30), 0.02);
assert.equal(voiceRatePerMinuteUsd('0.0095', 0), 0.0095);
assert.equal(voiceRatePerMinuteUsd('0.0095', undefined), 0.0095);
assert.equal(voiceRatePerMinuteUsd(Number.NaN), 0);
assert.equal(voiceRatePerMinuteUsd('not-a-rate'), 0);
assert.equal(voiceRatePerMinuteUsd(null), 0);
assert.equal(voiceRatePerMinuteUsd('0.01', Number.NaN), 0.01);

console.log('plivoVoicePricing.check.ts: ok');
