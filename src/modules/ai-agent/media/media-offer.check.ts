/**
 * Runnable check for media offer / affirm helpers.
 * Run: npx tsx src/modules/ai-agent/media/media-offer.check.ts
 */
import assert from 'node:assert/strict';
import {
  buildMediaOfferLine,
  isMediaCapabilityRefusal,
  looksLikeMediaAffirmation,
  shouldAutoSendMedia,
} from './media-offer.js';

assert.equal(shouldAutoSendMedia('pricing'), true);
assert.equal(shouldAutoSendMedia('media_request'), true);
assert.equal(shouldAutoSendMedia('feature_question'), false);

assert.equal(looksLikeMediaAffirmation('haan'), true);
assert.equal(looksLikeMediaAffirmation('bhejo'), true);
assert.equal(looksLikeMediaAffirmation('yes please'), true);
assert.equal(looksLikeMediaAffirmation('inbox kaise kaam karta hai'), false);

const line = buildMediaOfferLine('Inbox overview', 'image');
assert.match(line, /Inbox overview/);
assert.match(line, /Bhej doon/);

assert.equal(
  isMediaCapabilityRefusal(
    'Mujhe specific images share karne ki capability nahi hai.'
  ),
  true
);

console.log('media-offer.check: ok');
