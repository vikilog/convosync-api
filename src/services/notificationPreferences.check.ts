/**
 * Runnable self-check (no DB).
 *   npx tsx src/services/notificationPreferences.check.ts
 */
import assert from 'node:assert/strict';
import {
  defaultChannels,
  parseChannels,
  resolveEmailRecipients,
  resolveWhatsAppPhones,
  applyNotifyTemplate,
  buildWhatsAppBodyParams,
  isNotificationEventType,
  DEFAULT_HANDOFF_EMAIL_SUBJECT,
} from './notificationPreferences.service.js';

assert.equal(isNotificationEventType('human_handoff'), true);

const rendered = applyNotifyTemplate(
  'Handoff: {{customer_name}} — {{reason}}',
  { customer_name: 'Priya', reason: 'asked for human', customer_phone: 'x' }
);
assert.equal(rendered, 'Handoff: Priya — asked for human');

const parsed = parseChannels({
  email: {
    enabled: true,
    recipients: {
      workspaceEmail: true,
      userIds: [],
      extraEmails: ['ops@brand.com'],
    },
    subjectTemplate: 'Alert {{customer_name}}',
    bodyTemplate: 'See {{conversation_id}}',
  },
  whatsapp: {
    enabled: true,
    phoneNumbers: ['+91 98765 43210', 'bad'],
    userIds: ['u1'],
    templateId: 'tmpl_1',
    variableMap: { var_1: 'customer_name', var_2: 'reason' },
  },
});
assert.equal(parsed.email.subjectTemplate, 'Alert {{customer_name}}');
assert.equal(parsed.whatsapp.enabled, true);
assert.deepEqual(parsed.whatsapp.phoneNumbers, ['+919876543210']);
assert.equal(parsed.whatsapp.templateId, 'tmpl_1');

assert.deepEqual(
  buildWhatsAppBodyParams(
    ['var_1', 'var_2', 'var_3'],
    parsed.whatsapp.variableMap,
    { customer_name: 'Asha', reason: 'billing', conversation_id: 'c1' }
  ),
  ['Asha', 'billing', '']
);

assert.deepEqual(
  resolveWhatsAppPhones({
    channels: parsed,
    memberPhonesByUserId: new Map([['u1', '+91-90000-11111']]),
  }).sort(),
  ['919000011111', '919876543210']
);

assert.equal(defaultChannels().email.subjectTemplate, DEFAULT_HANDOFF_EMAIL_SUBJECT);
assert.equal(defaultChannels().whatsapp.enabled, false);

assert.deepEqual(
  resolveEmailRecipients({
    channels: defaultChannels(),
    workspaceEmail: 'desk@co.com',
    memberEmailsByUserId: new Map(),
  }),
  ['desk@co.com']
);

console.log('notificationPreferences.check: ok');
