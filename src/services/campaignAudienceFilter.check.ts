import assert from 'node:assert';
import { resolveSegmentIdsFromFilter } from './campaignAudienceFilter.js';

// CSV audience has no real implementation — must fail loudly, never silently
// broadcast to the entire workspace.
assert.throws(
  () => resolveSegmentIdsFromFilter('csv', {}),
  /CSV audience upload is not supported yet/,
  'audienceType csv must throw instead of falling back to all contacts'
);

// Existing behavior must be unaffected.
assert.deepStrictEqual(resolveSegmentIdsFromFilter('all', {}), ['all']);
assert.deepStrictEqual(resolveSegmentIdsFromFilter('segment', { segmentIds: ['tag:vip'] }), [
  'tag:vip',
]);
assert.deepStrictEqual(resolveSegmentIdsFromFilter('tag', { tag: 'vip' }), ['tag:vip']);
assert.deepStrictEqual(resolveSegmentIdsFromFilter('segment', {}), ['all']);

console.log('campaignAudienceFilter.check.ts: ok');
