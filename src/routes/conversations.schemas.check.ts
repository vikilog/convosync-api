import assert from 'node:assert/strict';
import {
  conversationAttachmentQuerySchema,
  conversationEmailSendBodySchema,
  conversationListQuerySchema,
  conversationMessagesQuerySchema,
  conversationOpenBodySchema,
  conversationSendMessageBodySchema,
  conversationSendTemplateBodySchema,
  conversationUpdateBodySchema,
} from './conversations.schemas.js';

assert.equal(conversationListQuerySchema.safeParse({}).success, true);
assert.equal(
  conversationListQuerySchema.safeParse({ status: '', assignedTo: 'u1', channel: 'whatsapp' })
    .success,
  true
);

assert.equal(conversationOpenBodySchema.safeParse({}).success, true);
assert.equal(conversationOpenBodySchema.safeParse({ contactId: 'c1' }).success, true);
assert.equal(
  conversationOpenBodySchema.safeParse({ contactId: 'c1', phoneNumberId: 'pn' }).success,
  true
);

assert.equal(conversationEmailSendBodySchema.safeParse({}).success, true);
assert.equal(
  conversationEmailSendBodySchema.safeParse({
    contactId: 'c1',
    subject: '',
    text: 'hi',
    html: '<p>hi</p>',
    templateId: 't1',
  }).success,
  true
);

assert.equal(conversationMessagesQuerySchema.safeParse({}).success, true);
assert.equal(
  conversationMessagesQuerySchema.safeParse({ limit: '50', before: 'm1' }).success,
  true
);
assert.equal(conversationMessagesQuerySchema.safeParse({ limit: 50 }).success, false);

assert.equal(conversationAttachmentQuerySchema.safeParse({}).success, true);
assert.equal(conversationAttachmentQuerySchema.safeParse({ index: '0' }).success, true);

assert.equal(conversationSendMessageBodySchema.safeParse({}).success, true);
assert.equal(conversationSendMessageBodySchema.safeParse({ content: '' }).success, true);
assert.equal(conversationSendMessageBodySchema.safeParse({ content: '  ' }).success, true);
assert.equal(conversationSendMessageBodySchema.safeParse({ content: 'hi' }).success, true);
assert.equal(conversationSendMessageBodySchema.safeParse({ content: 1 }).success, true);

assert.equal(conversationSendTemplateBodySchema.safeParse({}).success, true);
assert.equal(
  conversationSendTemplateBodySchema.safeParse({ templateId: 't', variables: ['a'] }).success,
  true
);
assert.equal(
  conversationSendTemplateBodySchema.safeParse({ templateId: 't', variables: [1] }).success,
  true
);
assert.equal(
  conversationSendTemplateBodySchema.safeParse({ variables: 'not-an-array' }).success,
  true
);

assert.equal(conversationUpdateBodySchema.safeParse(undefined).success, true);
assert.equal(conversationUpdateBodySchema.safeParse({}).success, true);
assert.equal(
  conversationUpdateBodySchema.safeParse({
    isFavorite: true,
    status: 'open',
    assigneeType: 'user',
    assigneeId: null,
    assignedTo: 'u1',
  }).success,
  true
);

console.log('conversations.schemas.check.ts: ok');
