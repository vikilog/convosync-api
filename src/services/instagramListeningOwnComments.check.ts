/**
 * ponytail: own-comment filter self-check.
 * Run: npx tsx src/services/instagramListeningOwnComments.check.ts
 */
import {
  filterOutOwnListeningComments,
  type InstagramListeningComment,
} from './instagramListening.service.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sample: InstagramListeningComment[] = [
  {
    id: '1',
    text: 'Price please?',
    username: 'customer1',
    timestamp: null,
    likeCount: 0,
    fromId: 'cust1',
    replies: [
      {
        id: '1a',
        text: 'Thanks — DMing you!',
        username: 'convo.sync',
        timestamp: null,
        likeCount: 0,
        fromId: 'page1',
        replies: [],
      },
    ],
  },
  {
    id: '2',
    text: 'Thanks — DMing you!',
    username: 'convo.sync',
    timestamp: null,
    likeCount: 0,
    fromId: 'page1',
    replies: [],
  },
];

const filtered = filterOutOwnListeningComments(sample, {
  instagramUserId: 'page1',
  username: 'convo.sync',
});

assert(filtered.length === 1, 'top-level own dropped');
assert(filtered[0].id === '1', 'customer kept');
assert(filtered[0].replies.length === 0, 'nested own dropped');
assert(
  filterOutOwnListeningComments(sample, { username: 'Convo.Sync' }).length === 1,
  'username case-insensitive'
);

console.log('instagramListeningOwnComments.check: ok');
