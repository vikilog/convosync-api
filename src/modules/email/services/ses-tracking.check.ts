/**
 * Self-check: permission error formatting dedupes AWS denial action repeats.
 * Run: npx tsx src/modules/email/services/ses-tracking.check.ts
 */
import assert from 'node:assert/strict';
import {
  SES_TRACKING_IAM_ACTIONS,
  formatTrackingPermissionError,
  sesTrackingIamPolicyDocument,
} from './ses-tracking.service.ts';

const awsDenial = new Error(
  'User: arn:aws:iam::123:user/ses is not authorized to perform: ses:CreateConfigurationSet ' +
    'on resource: arn:aws:ses:us-east-1:123:configuration-set/x because no identity-based ' +
    'policy allows the ses:CreateConfigurationSet action'
);
(awsDenial as { name: string }).name = 'AccessDenied';

const msg = formatTrackingPermissionError(awsDenial);
assert.ok(msg.includes('Required:'), msg);
assert.match(msg, /AWS denied: ses:CreateConfigurationSet\)/);
assert.doesNotMatch(msg, /ses:us\b/);
// Old bug: same action listed twice from AWS denial text (before EventDestination).
assert.doesNotMatch(
  msg,
  /ses:CreateConfigurationSet,\s*ses:CreateConfigurationSet(?:\s|,|\.|$)/
);
const requiredPart = msg.slice(msg.indexOf('Required:'));
const listed = SES_TRACKING_IAM_ACTIONS.join(', ');
assert.ok(requiredPart.includes(listed), `full action list missing in: ${msg}`);
assert.equal(requiredPart.split(listed).length - 1, 1, `Required list duplicated: ${msg}`);

const policy = sesTrackingIamPolicyDocument();
assert.deepEqual(policy.Statement[0]?.Action, [...SES_TRACKING_IAM_ACTIONS]);

console.log('ses-tracking self-check OK');
