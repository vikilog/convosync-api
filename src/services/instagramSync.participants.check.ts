/**
 * ponytail: customer pick must recover IGSID from messages when participants omit it.
 * Run: npx tsx backend/src/services/instagramSync.participants.check.ts
 */
import {
  isInstagramPageSender,
  pickCustomerFromMessages,
  pickCustomerParticipant,
  resolveInstagramThreadCustomer,
} from './instagramSyncParticipants.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const pageId = 'page-1';
const igId = 'ig-biz-1';

assert(isInstagramPageSender(pageId, pageId, igId), 'page id is ours');
assert(isInstagramPageSender(igId, pageId, igId), 'ig biz id is ours');
assert(!isInstagramPageSender('user-9', pageId, igId), 'customer is not ours');

const fromParticipants = pickCustomerParticipant(
  [{ id: igId, username: 'biz' }, { id: 'user-9', username: 'alice' }],
  pageId,
  igId
);
assert(fromParticipants?.id === 'user-9', 'participant pick should prefer customer');

const onlyBiz = pickCustomerParticipant([{ id: igId }], pageId, igId);
assert(onlyBiz === undefined, 'biz-only participants → no customer');

const fromMessages = pickCustomerFromMessages(
  [
    { id: 'm1', from: { id: igId, username: 'biz' }, message: 'hi' },
    { id: 'm2', from: { id: 'user-9', username: 'alice' }, message: 'hey' },
  ],
  pageId,
  igId
);
assert(fromMessages?.id === 'user-9', 'message from should recover customer when participants empty');

const recovered = resolveInstagramThreadCustomer(
  [{ id: igId }],
  [{ id: 'm2', from: { id: 'user-9' }, message: 'hey' }],
  pageId,
  igId
);
assert(recovered?.id === 'user-9', 'resolve should fall back to messages');

const outboundOnly = pickCustomerFromMessages(
  [{ id: 'm1', from: { id: igId }, message: 'promo' }],
  pageId,
  igId
);
assert(outboundOnly === undefined, 'outbound-only thread has no customer from from-field');

console.log('instagramSync.participants.check: ok');
