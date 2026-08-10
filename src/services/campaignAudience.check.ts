/**
 * Run: npx tsx src/services/campaignAudience.check.ts
 */
import assert from 'node:assert/strict';
import {
  audienceTagFromIds,
  normalizeSegmentIds,
  resolveSegmentIdsFromFilter,
  segmentLabelFromIds,
  segmentsWhere,
} from './campaignAudienceFilter.js';

assert.deepEqual(normalizeSegmentIds(null), ['all']);
assert.deepEqual(normalizeSegmentIds('all'), ['all']);
assert.deepEqual(normalizeSegmentIds(['tag:a', 'all', 'tag:b']), ['all']);
assert.deepEqual(normalizeSegmentIds(['tag:a', 'tag:b', 'tag:a']), ['tag:a', 'tag:b']);

assert.deepEqual(segmentsWhere('all'), {});
assert.deepEqual(segmentsWhere('tag:Hot'), { tags: { has: 'Hot' } });
assert.deepEqual(segmentsWhere(['tag:Hot', 'tag:Lead']), {
  tags: { hasSome: ['Hot', 'Lead'] },
});

assert.deepEqual(
  resolveSegmentIdsFromFilter('segment', { segmentIds: ['tag:a', 'tag:b'] }),
  ['tag:a', 'tag:b']
);
assert.deepEqual(resolveSegmentIdsFromFilter('segment', { segmentId: 'tag:x' }), ['tag:x']);
assert.deepEqual(resolveSegmentIdsFromFilter('all', { segmentIds: ['tag:a'] }), ['all']);

assert.equal(segmentLabelFromIds('tag:test'), 'Tag: test');
assert.equal(segmentLabelFromIds(['tag:a', 'tag:b']), 'Tags: a, b');
assert.equal(audienceTagFromIds(['tag:a', 'tag:b']), 'a, b');

console.log('campaignAudience.check.ts: ok');
