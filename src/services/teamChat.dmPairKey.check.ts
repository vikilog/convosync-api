/**
 * Runnable check for dmPairKey ordering.
 * Run: npx tsx src/services/teamChat.dmPairKey.check.ts
 */
import { dmPairKey } from './teamChat.service.js';
import assert from 'node:assert/strict';

assert.equal(dmPairKey('a', 'b'), 'a:b');
assert.equal(dmPairKey('b', 'a'), 'a:b');
assert.equal(dmPairKey('same', 'same'), 'same:same');
console.log('ok: dmPairKey');
