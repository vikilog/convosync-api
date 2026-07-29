/**
 * ponytail: self-check for IG username matching used on contact overview.
 * Run: npx tsx src/services/contactLink.igUsernames.check.ts
 */
import assert from 'node:assert/strict';
import {
  igUsernamesForContactGroup,
  normalizeIgUsername,
} from './contactIgUsernames.js';

assert.equal(normalizeIgUsername('@Aee_Vikaswa'), 'aee_vikaswa');
assert.equal(normalizeIgUsername('17841400000'), null);
assert.equal(normalizeIgUsername('lead:abc'), null);

const names = igUsernamesForContactGroup({
  channels: [
    {
      channel: 'instagram',
      name: '@aee_vikaswa',
      phone: 'ig:17841405783187240',
    },
    {
      channel: 'whatsapp',
      name: 'Vikas',
      phone: '+919999',
    },
  ],
  journeyUsername: 'Aee_Vikaswa',
});
assert.deepEqual(names, ['aee_vikaswa']);

console.log('contactLink.igUsernames.check: ok');
