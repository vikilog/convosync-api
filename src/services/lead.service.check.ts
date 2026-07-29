/**
 * Run: npx tsx src/services/lead.service.check.ts
 */
import { phoneForLeadContact } from './leadContactPhone.js';

console.assert(
  phoneForLeadContact({ id: 'abc', phone: '9876543210' }) === '9876543210',
  'prefers real phone'
);
console.assert(
  phoneForLeadContact({ id: 'abc', phone: '  ' }) === 'ig:lead:abc',
  'falls back to ig:lead id'
);
console.assert(
  phoneForLeadContact({ id: 'xyz', phone: null }) === 'ig:lead:xyz',
  'null phone → synthetic'
);

console.log('lead.service.check.ts: ok');
