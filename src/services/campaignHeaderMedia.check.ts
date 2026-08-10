/**
 * Run: npx tsx src/services/campaignHeaderMedia.check.ts
 */
import assert from 'node:assert/strict';
import {
  hasCampaignHeaderMediaSource,
  parseCampaignHeaderMediaOverride,
} from './campaignHeaderMedia.js';

assert.equal(parseCampaignHeaderMediaOverride(null).headerMediaStorageKey, undefined);
assert.equal(parseCampaignHeaderMediaOverride({ foo: 1 }).headerMediaAssetId, undefined);
const parsed = parseCampaignHeaderMediaOverride({
  headerMediaStorageKey: ' ws/template-headers/a.jpg ',
  headerMediaMimeType: 'image/jpeg',
  headerMediaFileName: 'a.jpg',
  headerMediaAssetId: '  ',
});
assert.equal(parsed.headerMediaStorageKey, 'ws/template-headers/a.jpg');
assert.equal(parsed.headerMediaMimeType, 'image/jpeg');
assert.equal(parsed.headerMediaFileName, 'a.jpg');
assert.equal(parsed.headerMediaAssetId, undefined);

assert.equal(hasCampaignHeaderMediaSource({}, null), false);
assert.equal(hasCampaignHeaderMediaSource({}, ''), false);
assert.equal(hasCampaignHeaderMediaSource({}, 'key'), true);
assert.equal(
  hasCampaignHeaderMediaSource({ headerMediaStorageKey: 'k' }, null),
  true
);
assert.equal(hasCampaignHeaderMediaSource({ headerMediaAssetId: 'm1' }, null), true);

console.log('campaignHeaderMedia.check.ts: ok');
