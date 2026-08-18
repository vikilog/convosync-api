/**
 * Run: npx tsx src/services/leadContactPhone.check.ts
 */
import assert from 'node:assert/strict';
import { phoneForLeadContact } from './leadContactPhone.js';

// A formatted real phone must normalize to digits-only, matching how
// upsertWhatsAppContact stores WhatsApp-sourced contacts — otherwise
// convertLeadToContact's exact-string lookup misses the existing row and
// creates a duplicate contact for the same person.
assert.equal(phoneForLeadContact({ id: 'l1', phone: '+91 98765 43210' }), '919876543210');
assert.equal(phoneForLeadContact({ id: 'l1', phone: '919876543210' }), '919876543210');
assert.equal(phoneForLeadContact({ id: 'l1', phone: '  +1 (212) 555-0147  ' }), '12125550147');

// No usable phone falls back to the stable Instagram-lead placeholder.
assert.equal(phoneForLeadContact({ id: 'lead-123', phone: null }), 'ig:lead:lead-123');
assert.equal(phoneForLeadContact({ id: 'lead-123', phone: '' }), 'ig:lead:lead-123');
assert.equal(phoneForLeadContact({ id: 'lead-123', phone: '12' }), 'ig:lead:lead-123');

console.log('leadContactPhone.check.ts: ok');
