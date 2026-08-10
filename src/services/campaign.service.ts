import {
  getCampaignAudienceContacts,
  resolveSegmentIdsFromFilter,
  segmentIdToTag,
  type CampaignAudienceChannel,
} from './campaignAudience.service.js';

type CampaignAudienceFilter = {
  channel?: CampaignAudienceChannel;
  segmentId?: string;
  segmentIds?: string[];
  tag?: string;
};

function parseAudienceFilter(raw: unknown): CampaignAudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  return raw as CampaignAudienceFilter;
}

export async function getCampaignAudience(workspaceId: string, audienceType: string, audienceFilter?: unknown) {
  const filter = parseAudienceFilter(audienceFilter);
  const channel = filter.channel ?? 'whatsapp';
  const segmentIds = resolveSegmentIdsFromFilter(audienceType, filter);
  return getCampaignAudienceContacts(workspaceId, channel, segmentIds);
}

export { segmentIdToTag };
