import {
  countCampaignAudience,
  getCampaignAudienceContacts,
  resolveAudienceCountArgs,
  segmentIdToTag,
} from './campaignAudience.service.js';

export async function getCampaignAudience(workspaceId: string, audienceType: string, audienceFilter?: unknown) {
  const { channel, segmentIds } = resolveAudienceCountArgs(audienceType, audienceFilter);
  return getCampaignAudienceContacts(workspaceId, channel, segmentIds);
}

/** Live union/dedupe count for the campaign audience filter (channel + tags). */
export async function countCampaignAudienceFromFilter(
  workspaceId: string,
  audienceType: string,
  audienceFilter?: unknown
) {
  const { channel, segmentIds } = resolveAudienceCountArgs(audienceType, audienceFilter);
  return countCampaignAudience(workspaceId, channel, segmentIds);
}

export { resolveAudienceCountArgs, segmentIdToTag };
