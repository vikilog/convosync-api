import {
  countCampaignAudience,
  getCampaignAudienceContacts,
  resolveAudienceCountArgs,
  segmentIdToTag,
} from './campaignAudience.service.js';

export async function getCampaignAudience(workspaceId: string, audienceType: string, audienceFilter?: unknown) {
  const { channel, segmentIds, tagMatchMode } = resolveAudienceCountArgs(audienceType, audienceFilter);
  return getCampaignAudienceContacts(workspaceId, channel, segmentIds, tagMatchMode);
}

/** Live union/intersection count for the campaign audience filter (channel + tags + match mode). */
export async function countCampaignAudienceFromFilter(
  workspaceId: string,
  audienceType: string,
  audienceFilter?: unknown
) {
  const { channel, segmentIds, tagMatchMode } = resolveAudienceCountArgs(audienceType, audienceFilter);
  return countCampaignAudience(workspaceId, channel, segmentIds, tagMatchMode);
}

export { resolveAudienceCountArgs, segmentIdToTag };
