import {
  mapIntentToReviewLabel,
  mapStatusToReviewStatus,
  needsReviewQueue,
  SOCIAL_COMMENT_LOW_CONFIDENCE,
} from './socialCommentClassify.service.js';

console.assert(mapIntentToReviewLabel('interested') === 'Interested');
console.assert(mapIntentToReviewLabel('unclear') === 'Neutral');
console.assert(mapStatusToReviewStatus('new') === 'pending');
console.assert(mapStatusToReviewStatus('replied') === 'approved');
console.assert(
  needsReviewQueue({ status: 'new', intent: 'interested', confidence: 0.9 }) === false
);
console.assert(
  needsReviewQueue({
    status: 'new',
    intent: 'interested',
    confidence: SOCIAL_COMMENT_LOW_CONFIDENCE - 0.01,
  }) === true
);
console.assert(needsReviewQueue({ status: 'new', intent: 'spam', confidence: 0.99 }) === true);
console.assert(needsReviewQueue({ status: 'approved', intent: 'unclear', confidence: 0.1 }) === false);

console.log('socialCommentClassify.service.check: ok');
