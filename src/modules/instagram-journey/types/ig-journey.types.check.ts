/**
 * Run: npx tsx src/modules/instagram-journey/types/ig-journey.types.check.ts
 */
import assert from 'node:assert/strict';
import {
  IG_CONTENT_BLOCK_TYPES,
  IG_JOURNEY_NODE_TYPES,
  IG_SEND_AS_MODES,
  IG_TRIGGER_EVENTS,
  allowedIgSendMessageBlocks,
  findDisallowedSendMessageBlockTypes,
  findDisallowedSendMessageKeys,
  isComingSoonBlockType,
  isContentAllowedForSendAs,
  matchesKeyword,
  normalizeIgSendMessageBlocks,
  normalizeIgTriggerEvents,
  resolveIgSendAs,
  resolvePrivateReplyCommentId,
  triggerAllowsEvent,
} from './ig-journey.types.ts';

assert.equal(IG_JOURNEY_NODE_TYPES.length, 17);
assert.ok(IG_JOURNEY_NODE_TYPES.includes('GOTO_STEP'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('ADD_TO_FUNNEL'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('WAIT'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('CONDITION'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('RANDOMIZER'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('BUTTONS'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('WEBHOOK'));
assert.ok(IG_JOURNEY_NODE_TYPES.includes('ASSIGN_TO'));
assert.deepEqual(
  IG_TRIGGER_EVENTS.map((e) => e.value),
  ['dm.received', 'comment.received']
);
assert.equal(matchesKeyword('hello price please', ''), true);
assert.equal(matchesKeyword('hello price please', 'PRICE'), true);
assert.equal(matchesKeyword('hello', 'price'), false);

assert.deepEqual(normalizeIgTriggerEvents({ event: 'comment.received' }), [
  'comment.received',
]);
assert.deepEqual(
  normalizeIgTriggerEvents({
    event: 'dm.received',
    events: ['dm.received', 'comment.received'],
  }),
  ['dm.received', 'comment.received']
);
assert.equal(
  triggerAllowsEvent({ events: ['dm.received', 'comment.received'] }, 'comment.received'),
  true
);
assert.equal(triggerAllowsEvent({ event: 'dm.received' }, 'comment.received'), false);
assert.equal(triggerAllowsEvent({}, 'dm.received'), true);

// Send as: exactly 2 canonical modes.
assert.deepEqual(IG_SEND_AS_MODES, ['private_reply', 'window_24h']);

// resolveIgSendAs — missing/invalid/legacy 'dm' → 'window_24h', matching pre-existing
// always-DM behavior (backward compat for journeys saved before the rename).
assert.equal(resolveIgSendAs(undefined), 'window_24h');
assert.equal(resolveIgSendAs({}), 'window_24h');
assert.equal(resolveIgSendAs({ sendAs: 'window_24h' }), 'window_24h');
assert.equal(resolveIgSendAs({ sendAs: 'dm' }), 'window_24h', 'legacy value still reads as 24h window');
assert.equal(resolveIgSendAs({ sendAs: 'private_reply' }), 'private_reply');
assert.equal(resolveIgSendAs({ sendAs: 'bogus' }), 'window_24h');

// isContentAllowedForSendAs — private reply is text(+buttons) only; 24h window allows all.
assert.equal(isContentAllowedForSendAs('private_reply', 'text'), true);
assert.equal(isContentAllowedForSendAs('private_reply', 'buttons'), true);
assert.equal(isContentAllowedForSendAs('private_reply', 'image'), false);
assert.equal(isContentAllowedForSendAs('private_reply', 'pdf'), false);
assert.equal(isContentAllowedForSendAs('private_reply', 'card'), false);
assert.equal(isContentAllowedForSendAs('window_24h', 'image'), true);
assert.equal(isContentAllowedForSendAs('dm', 'image'), true, 'legacy dm behaves like window_24h');
assert.equal(isContentAllowedForSendAs(undefined, 'video'), true, 'missing sendAs defaults to allow-all (24h)');

// findDisallowedSendMessageKeys — no-op today (builder never writes extra keys), but a real
// guard once a rich content-block picker lands.
assert.deepEqual(findDisallowedSendMessageKeys({ text: 'hi', sendAs: 'private_reply' }), []);
assert.deepEqual(
  findDisallowedSendMessageKeys({ text: 'hi', sendAs: 'window_24h', imageUrl: 'x' }),
  [],
  '24h window has nothing to reject'
);
assert.deepEqual(
  findDisallowedSendMessageKeys({ text: 'hi', sendAs: 'private_reply', imageUrl: 'x' }),
  ['imageUrl']
);
assert.deepEqual(findDisallowedSendMessageKeys(null), []);

// resolvePrivateReplyCommentId — the Part 3 eligibility gate.
const commentCtx = {
  triggerEvent: 'comment.received',
  triggerPayload: { commentId: 'c_1', postId: 'p_1' },
};
assert.equal(
  resolvePrivateReplyCommentId(commentCtx, { sendAs: 'private_reply' }),
  'c_1',
  'eligible: comment trigger + opted in + not yet used'
);
assert.equal(
  resolvePrivateReplyCommentId(commentCtx, { sendAs: 'dm' }),
  null,
  'sendAs dm never uses private reply'
);
assert.equal(
  resolvePrivateReplyCommentId(commentCtx, {}),
  null,
  'missing sendAs defaults to dm (backward compatible — no behavior change for old nodes)'
);
assert.equal(
  resolvePrivateReplyCommentId({ triggerEvent: 'dm.received', triggerPayload: {} }, { sendAs: 'private_reply' }),
  null,
  'non-comment trigger never uses private reply'
);
assert.equal(
  resolvePrivateReplyCommentId({ ...commentCtx, privateReplySent: true }, { sendAs: 'private_reply' }),
  null,
  'already used once this run -> subsequent SEND_MESSAGE nodes fall back to DM'
);
assert.equal(
  resolvePrivateReplyCommentId(null, { sendAs: 'private_reply' }),
  null,
  'missing execution context never throws'
);

// normalizeIgSendMessageBlocks — migrate-on-read: legacy `text` becomes one text block.
assert.deepEqual(normalizeIgSendMessageBlocks({ text: 'hi' }), [
  { id: 'legacy_text', type: 'text', text: 'hi' },
]);
assert.deepEqual(normalizeIgSendMessageBlocks({ text: '' }), [
  { id: 'legacy_text', type: 'text', text: '' },
]);
assert.deepEqual(normalizeIgSendMessageBlocks(null), [
  { id: 'legacy_text', type: 'text', text: '' },
]);
assert.deepEqual(
  normalizeIgSendMessageBlocks({
    text: 'ignored once blocks exist',
    blocks: [{ id: 'b1', type: 'text', text: 'from blocks' }],
  }),
  [{ id: 'b1', type: 'text', text: 'from blocks' }],
  'blocks win over legacy text once present'
);
assert.deepEqual(
  normalizeIgSendMessageBlocks({ blocks: [{ type: 'image', mediaId: 'm1' }] })[0],
  { id: 'block_0', type: 'image', mediaId: 'm1' },
  'missing block id gets a positional fallback'
);
assert.deepEqual(
  normalizeIgSendMessageBlocks({ text: 'fallback', blocks: [{ id: 'x' }, 'nope', 42] }),
  [{ id: 'legacy_text', type: 'text', text: 'fallback' }],
  'blocks with no valid type are dropped; empty result falls back to legacy text'
);

// allowedIgSendMessageBlocks — the runtime gate the engine executes against.
assert.deepEqual(
  allowedIgSendMessageBlocks({
    sendAs: 'private_reply',
    blocks: [
      { id: 't', type: 'text', text: 'hi' },
      { id: 'i', type: 'image', mediaId: 'm1' },
    ],
  }),
  [{ id: 't', type: 'text', text: 'hi' }],
  'private_reply drops rich blocks, keeps text'
);
assert.equal(
  allowedIgSendMessageBlocks({
    sendAs: 'window_24h',
    blocks: [
      { id: 't', type: 'text', text: 'hi' },
      { id: 'i', type: 'image', mediaId: 'm1' },
    ],
  }).length,
  2,
  '24h window keeps every block'
);

// findDisallowedSendMessageBlockTypes — the publish-time guard.
assert.deepEqual(
  findDisallowedSendMessageBlockTypes({
    sendAs: 'private_reply',
    blocks: [
      { id: 't', type: 'text', text: 'hi' },
      { id: 'i', type: 'image', mediaId: 'm1' },
      { id: 'c', type: 'card', title: 'x' },
    ],
  }),
  ['image', 'card']
);
assert.deepEqual(
  findDisallowedSendMessageBlockTypes({
    sendAs: 'window_24h',
    blocks: [{ id: 'i', type: 'image', mediaId: 'm1' }],
  }),
  [],
  '24h window has nothing to reject'
);
assert.deepEqual(findDisallowedSendMessageBlockTypes(null), []);

// isComingSoonBlockType — Dynamic / Data Collection have no engine send path yet.
assert.equal(isComingSoonBlockType('dynamic'), true);
assert.equal(isComingSoonBlockType('data_collection'), true);
assert.equal(isComingSoonBlockType('image'), false);
assert.equal(isComingSoonBlockType('text'), false);
for (const t of IG_CONTENT_BLOCK_TYPES) {
  assert.equal(typeof isComingSoonBlockType(t), 'boolean');
}

console.log('ig-journey.types.check: ok');
