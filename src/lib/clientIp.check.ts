/**
 * Self-check: X-Forwarded-For / IP normalize helpers.
 * Run: npx tsx backend/src/lib/clientIp.check.ts
 */
import assert from 'node:assert/strict';
import { clientIpFromRequest, normalizeIp } from './clientIp.js';
import {
  buildLocaleSuggestion,
  detectionHint,
  isValidIanaTimeZone,
} from '../services/geoip/index.js';

assert.equal(normalizeIp('::ffff:203.0.113.10'), '203.0.113.10');
assert.equal(normalizeIp(' 203.0.113.10 '), '203.0.113.10');

assert.equal(
  clientIpFromRequest({
    ip: '127.0.0.1',
    ips: [],
    headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' },
  } as never),
  '203.0.113.50'
);

assert.equal(
  clientIpFromRequest({
    ip: '203.0.113.9',
    ips: ['203.0.113.9'],
    headers: {},
  } as never),
  '203.0.113.9'
);

assert.equal(
  clientIpFromRequest({
    ip: '10.0.0.2',
    ips: ['10.0.0.2'],
    headers: { 'x-forwarded-for': '192.168.1.1' },
  } as never),
  null
);

assert.equal(isValidIanaTimeZone('Asia/Kolkata'), true);
assert.equal(isValidIanaTimeZone('Not/AZone'), false);
assert.equal(isValidIanaTimeZone(''), false);

const fromBrowser = buildLocaleSuggestion({
  browserTimezone: 'Asia/Kolkata',
  geo: { countryCode: 'IN', timeZone: 'Asia/Kolkata' },
});
assert.equal(fromBrowser.timezoneSource, 'browser');
assert.equal(fromBrowser.countrySource, 'ip');
assert.equal(detectionHint(fromBrowser.timezoneSource, 'timezone'), 'Detected from your device');
assert.equal(detectionHint(fromBrowser.countrySource, 'country'), 'Detected from your IP address');

const fromIp = buildLocaleSuggestion({
  browserTimezone: null,
  geo: { countryCode: 'US', timeZone: 'America/New_York' },
});
assert.equal(fromIp.timezoneSource, 'ip');
assert.equal(detectionHint(fromIp.timezoneSource, 'timezone'), 'Detected from your IP address');

console.log('clientIp.check.ts: ok');
