/**
 * ponytail: self-check for contact channel inference used by link groups (no DB).
 * Run: npx tsx src/services/contactLink.channel.check.ts
 */
import assert from 'node:assert/strict';
import {
  isInstagramPhone,
  isInstagramSource,
  isMessengerPhone,
  isMessengerSource,
} from '../lib/channelContact.js';

function channelForContact(contact: { phone: string; source?: string | null }) {
  if (isInstagramPhone(contact.phone) || isInstagramSource(contact.source)) return 'instagram';
  if (isMessengerPhone(contact.phone) || isMessengerSource(contact.source)) return 'messenger';
  return 'whatsapp';
}

assert.equal(channelForContact({ phone: '+15551234567', source: null }), 'whatsapp');
assert.equal(channelForContact({ phone: 'ig:alice', source: null }), 'instagram');
assert.equal(channelForContact({ phone: 'fb:123', source: null }), 'messenger');
assert.equal(channelForContact({ phone: '+1', source: 'Instagram' }), 'instagram');
assert.equal(channelForContact({ phone: '+1', source: 'Messenger' }), 'messenger');

console.log('contactLink.channel.check: ok');
