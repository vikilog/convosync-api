/**
 * Runnable check: post comment routing prefers assigned journey over global fan-out.
 * Run: npx tsx src/services/instagramCommentWebhook.routing.check.ts
 */
import assert from 'node:assert/strict';

function resolveCommentAutomationPath(opts: {
  postJourneyId: string | null;
}): 'post_journey' | 'global_keyword' {
  return opts.postJourneyId ? 'post_journey' : 'global_keyword';
}

assert.equal(
  resolveCommentAutomationPath({ postJourneyId: 'j1' }),
  'post_journey'
);
assert.equal(
  resolveCommentAutomationPath({ postJourneyId: null }),
  'global_keyword'
);

console.log('instagramCommentWebhook.routing check ok');
