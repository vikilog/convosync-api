import assert from 'node:assert/strict';
import { internalAuthCode, internalAuthHeaders } from './internalAuth.js';

assert.equal(internalAuthCode('', 'anything'), 503, 'unset secret must fail closed');
assert.equal(internalAuthCode('secret', ''), 401, 'missing header must 401');
assert.equal(internalAuthCode('secret', 'wrong'), 401, 'mismatch must 401');
assert.equal(internalAuthCode('secret', 'secret'), 204, 'match must pass');

assert.deepEqual(internalAuthHeaders('abc'), { 'X-ConvoSync-Internal': 'abc' });
assert.throws(() => internalAuthHeaders(''), /CONVOSYNC_INTERNAL_SECRET/);

console.log('internalAuth.check.ts: ok');
