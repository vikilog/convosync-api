/**
 * Assert shapeWebhookComment maps Meta comment payloads correctly.
 * Run: npx tsx src/services/instagramCommentWebhook.service.check.ts
 */
import {
  isInstagramCommentWebhookField,
  shapeWebhookComment,
} from './instagramCommentWebhook.shape.js';

const sample = shapeWebhookComment({
  from: { id: 'igsid_1', username: 'buyer_jane' },
  comment_id: 'comment_99',
  parent_id: 'comment_1',
  text: 'Price?',
  media: { id: 'media_55', media_product_type: 'FEED' },
});

console.assert(isInstagramCommentWebhookField('comments'), 'comments field');
console.assert(isInstagramCommentWebhookField('live_comments'), 'live_comments field');
console.assert(!isInstagramCommentWebhookField('messages'), 'messages not comment');
console.assert(sample?.postId === 'media_55', 'postId from media.id');
console.assert(sample?.comment.id === 'comment_99', 'comment_id');
console.assert(sample?.comment.parentCommentId === 'comment_1', 'parent_id');
console.assert(sample?.comment.username === 'buyer_jane', 'username');
console.assert(sample?.comment.fromId === 'igsid_1', 'fromId');

const legacyId = shapeWebhookComment({
  id: 'c_legacy',
  text: 'hi',
  media: { id: 'm1' },
  from: { id: 'u1', username: 'x' },
});
console.assert(legacyId?.comment.id === 'c_legacy', 'legacy value.id');

const removed = shapeWebhookComment({
  comment_id: 'c_gone',
  media: { id: 'm1' },
  verb: 'remove',
});
console.assert(removed === null, 'skip remove');

console.log('instagramCommentWebhook.service.check.ts: ok');
