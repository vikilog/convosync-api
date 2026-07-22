/**
 * ponytail: campaign {{contact.name}} must resolve per recipient, not send literally.
 * Run: npx tsx backend/src/services/campaignEmailVariables.check.ts
 */
import assert from 'node:assert/strict';
import {
  buildCampaignBodyParams,
  interpolateContactTokens,
  resolveCampaignEmailVariables,
  resolveMappingValue,
} from './campaignEmailVariables.ts';

const contact = {
  name: 'Vikas Swami',
  email: 'vikas@example.com',
  phone: '+919992492168',
  customFields: { city: 'Jaipur' },
};

assert.equal(interpolateContactTokens('Hi {{contact.name}},', contact), 'Hi Vikas Swami,');
assert.equal(resolveMappingValue('{{contact.name}}', contact), 'Vikas Swami');
assert.equal(resolveMappingValue('contact.name', contact), 'Vikas Swami');
assert.equal(resolveMappingValue('Static promo', contact), 'Static promo');

assert.deepEqual(
  buildCampaignBodyParams(['var_1'], { var_1: '{{contact.name}}' }, contact),
  ['Vikas Swami']
);

assert.deepEqual(
  resolveCampaignEmailVariables(contact, {}, ['contact.name', 'email', 'city']),
  {
    'contact.name': 'Vikas Swami',
    email: 'vikas@example.com',
    city: 'Jaipur',
  }
);

assert.deepEqual(
  resolveCampaignEmailVariables(contact, { greeting: 'Hey {{contact.first_name}}!' }, ['greeting']),
  { greeting: 'Hey Vikas!' }
);

console.log('campaignEmailVariables.check.ts: ok');
