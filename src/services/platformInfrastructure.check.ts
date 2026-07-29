import assert from 'node:assert/strict';
import { formatUptime } from './platformInfrastructure.js';

assert.equal(formatUptime(90), '1m');
assert.equal(formatUptime(3700), '1h 1m');
assert.equal(formatUptime(90000), '1d 1h');
console.log('platformInfrastructure.formatUptime: ok');
