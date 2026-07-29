/**
 * Runnable check: media asks must not stay labeled as human_request.
 * Run: npx tsx src/modules/ai-agent/intent-media-refine.check.ts
 */
import assert from 'node:assert/strict';
import {
  INTENTS,
  looksLikeHumanRequest,
  looksLikeMediaRequest,
  refineIntent,
} from './intent.service.js';

assert.equal(looksLikeMediaRequest('send image of convosync intro'), true);
assert.equal(looksLikeHumanRequest('send image of convosync intro'), false);
assert.equal(
  refineIntent(INTENTS.HUMAN_REQUEST, 'send image of convosync intro'),
  INTENTS.MEDIA_REQUEST
);
assert.equal(
  refineIntent(INTENTS.GENERAL, 'brochure bhejo'),
  INTENTS.MEDIA_REQUEST
);
assert.equal(
  refineIntent(INTENTS.GENERAL, 'talk to a human please'),
  INTENTS.HUMAN_REQUEST
);
assert.equal(looksLikeMediaRequest('Convosync kya hai?'), false);
assert.equal(looksLikeMediaRequest('what is convosync'), false);
assert.equal(looksLikeMediaRequest('Convosync k feature btao'), false);
assert.equal(looksLikeMediaRequest('Feature btao ?'), false);
assert.equal(looksLikeMediaRequest('Intro image do'), true);
assert.equal(looksLikeMediaRequest('intro image dedo'), true);
assert.equal(
  refineIntent(INTENTS.FEATURE_QUESTION, 'Convosync kya hai?'),
  INTENTS.FEATURE_QUESTION
);
assert.equal(
  refineIntent(INTENTS.MEDIA_REQUEST, 'What is convosync'),
  INTENTS.GENERAL
);

console.log('intent-media-refine.check: ok');
