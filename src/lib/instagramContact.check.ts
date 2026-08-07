/**
 * Run: npx tsx src/lib/instagramContact.check.ts
 */
import assert from 'node:assert/strict';
import { formatInstagramContactPhone, isInstagramPhone } from './channelContact.js';

assert.equal(formatInstagramContactPhone('17841405783187240'), 'ig:17841405783187240');
assert.equal(isInstagramPhone('ig:1'), true);
assert.equal(isInstagramPhone('fb:1'), false);
assert.equal(isInstagramPhone('36586673007584588'), false);

console.log('instagramContact.check: ok');
