/**
 * Run: npx tsx src/services/plivoXml.check.ts
 */
import assert from 'node:assert/strict';
import {
  extraHeaderCallerId,
  endpointUsernameFromSip,
  isPlivoEndpointSip,
  isPstnInboundToOwnedNumber,
  normalizeIndiaPstn,
  plivoXmlDialNumber,
  plivoXmlDialUser,
  sipUriForEndpoint,
  xmlEscape,
} from './plivoXml.js';

assert.equal(sipUriForEndpoint('csabc1234'), 'sip:csabc1234@phone.plivo.com');
assert.equal(sipUriForEndpoint('sip:already@phone.plivo.com'), 'sip:already@phone.plivo.com');
assert.equal(endpointUsernameFromSip('sip:csabc1234@phone.plivo.com'), 'csabc1234');
assert.equal(endpointUsernameFromSip('csabc1234@phone.plivo.com'), 'csabc1234');
assert.equal(isPlivoEndpointSip('sip:csabc1234@phone.plivo.com'), true);
assert.equal(isPlivoEndpointSip('+919653573824'), false);
assert.equal(isPstnInboundToOwnedNumber('912264231648', ['912264231648']), true);

const inbound = plivoXmlDialUser({
  callerId: '919653573824',
  sipUri: sipUriForEndpoint('csabc1234'),
  actionUrl: 'https://example.com/dial-callback?requestId=abc&from=%2B91',
});
assert.match(inbound, /<User>sip:csabc1234@phone\.plivo\.com<\/User>/);
assert.doesNotMatch(inbound, /<Client>/);
assert.match(inbound, /action="https:\/\/example\.com\/dial-callback\?requestId=abc&amp;from=%2B91"/);

const outbound = plivoXmlDialNumber({ callerId: '912264231648', number: '919653573824' });
assert.match(outbound, /<Number>919653573824<\/Number>/);
assert.doesNotMatch(outbound, /<Client>/);

assert.equal(xmlEscape('a&b'), 'a&amp;b');
assert.equal(extraHeaderCallerId({ 'X-PH-callerid': '912264231648' }), '912264231648');
assert.equal(extraHeaderCallerId({ 'X-PH-callerId': '912264231648' }), '912264231648');
assert.equal(extraHeaderCallerId({ From: 'sip:x@phone.plivo.com' }), '');

assert.equal(isPstnInboundToOwnedNumber('912264231648', ['912264231648']), true);
assert.equal(isPstnInboundToOwnedNumber('+91 22 6423 1648', ['912264231648']), true);
assert.equal(isPstnInboundToOwnedNumber('919653573824', ['912264231648']), false);

assert.equal(normalizeIndiaPstn('9653573824'), '919653573824');
assert.equal(normalizeIndiaPstn('919653573824'), '919653573824');
assert.equal(normalizeIndiaPstn('+91 96535 73824'), '919653573824');

console.log('plivoXml.check.ts: ok');
