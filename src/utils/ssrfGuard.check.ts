import assert from 'node:assert';
import { isBlockedIp } from './ssrfGuard.js';

// Cloud metadata + loopback + private ranges must all be blocked.
assert.strictEqual(isBlockedIp('169.254.169.254'), true, 'cloud metadata IP must be blocked');
assert.strictEqual(isBlockedIp('127.0.0.1'), true, 'loopback must be blocked');
assert.strictEqual(isBlockedIp('0.0.0.0'), true, '0.0.0.0 must be blocked');
assert.strictEqual(isBlockedIp('10.0.0.5'), true, '10.0.0.0/8 must be blocked');
assert.strictEqual(isBlockedIp('192.168.1.1'), true, '192.168.0.0/16 must be blocked');
assert.strictEqual(isBlockedIp('172.16.0.1'), true, '172.16.0.0/12 lower bound must be blocked');
assert.strictEqual(isBlockedIp('172.31.255.255'), true, '172.16.0.0/12 upper bound must be blocked');
assert.strictEqual(isBlockedIp('172.32.0.1'), false, '172.32.0.0 is outside 172.16.0.0/12');
assert.strictEqual(isBlockedIp('100.64.0.1'), true, 'CGNAT 100.64.0.0/10 must be blocked');
assert.strictEqual(isBlockedIp('::1'), true, 'IPv6 loopback must be blocked');
assert.strictEqual(isBlockedIp('fe80::1'), true, 'IPv6 link-local must be blocked');
assert.strictEqual(isBlockedIp('fd12:3456:789a::1'), true, 'IPv6 unique-local must be blocked');
assert.strictEqual(isBlockedIp('::ffff:169.254.169.254'), true, 'IPv4-mapped metadata IP must be blocked');

// Ordinary public addresses must pass.
assert.strictEqual(isBlockedIp('8.8.8.8'), false, 'public IPv4 must be allowed');
assert.strictEqual(isBlockedIp('93.184.216.34'), false, 'public IPv4 must be allowed');
assert.strictEqual(isBlockedIp('2606:4700:4700::1111'), false, 'public IPv6 must be allowed');

console.log('ssrfGuard.check.ts: ok');
