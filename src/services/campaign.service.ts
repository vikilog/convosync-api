import { prisma } from '../index.js';
import {
  getCampaignAudienceContacts,
  segmentIdToTag,
  type CampaignAudienceChannel,
} from './campaignAudience.service.js';

type CampaignAudienceFilter = {
  channel?: CampaignAudienceChannel;
  segmentId?: string;
  tag?: string;
};

function parseAudienceFilter(raw: unknown): CampaignAudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  return raw as CampaignAudienceFilter;
}

function resolveSegmentId(audienceType: string, filter: CampaignAudienceFilter): string {
  if (audienceType === 'all') return 'all';
  if (filter.segmentId) return filter.segmentId;
  if (filter.tag) return `tag:${filter.tag}`;
  return 'all';
}

export async function getCampaignAudience(workspaceId: string, audienceType: string, audienceFilter?: unknown) {
  const filter = parseAudienceFilter(audienceFilter);
  const channel = filter.channel ?? 'whatsapp';
  const segmentId = resolveSegmentId(audienceType, filter);
  return getCampaignAudienceContacts(workspaceId, channel, segmentId);
}

export { segmentIdToTag };
