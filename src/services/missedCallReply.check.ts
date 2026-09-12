/**
 * Run: npx tsx src/services/missedCallReply.check.ts
 */
import assert from 'node:assert/strict';
import {
  missedCallReplyConfig,
  shouldSendUserMissReply,
  wasDialAnswered,
} from './missedCallReply.service.js';

const row = {
  missedCallAutoReplyEnabled: true,
  missedCallMessage: 'sorry we missed you',
  missedCallTemplateId: 'tpl-platform',
  userMissedCallAutoReplyEnabled: true,
  userMissedCallMessage: 'sorry we could not reach you',
  userMissedCallTemplateId: null,
};

assert.deepEqual(missedCallReplyConfig(row, 'platform'), {
  enabled: true,
  message: 'sorry we missed you',
  templateId: 'tpl-platform',
});
assert.deepEqual(missedCallReplyConfig(row, 'user'), {
  enabled: true,
  message: 'sorry we could not reach you',
  templateId: null,
});

assert.equal(wasDialAnswered('completed'), true);
assert.equal(wasDialAnswered('ANSWERED'), true);
assert.equal(wasDialAnswered('no-answer'), false);
assert.equal(shouldSendUserMissReply('no-answer'), true);
assert.equal(shouldSendUserMissReply('busy'), true);
assert.equal(shouldSendUserMissReply('timeout'), true);
assert.equal(shouldSendUserMissReply('cancel'), false);
assert.equal(shouldSendUserMissReply('completed'), false);

console.log('missedCallReply.check.ts: ok');
