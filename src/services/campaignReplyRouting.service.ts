import { prisma } from '../index.js';

/** How long after a reply-routed campaign send a contact's next reply still routes to it. */
const CAMPAIGN_REPLY_ROUTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CampaignReplyRoute = {
  assigneeType: 'journey' | 'ai_agent';
  assigneeId: string;
  campaignId: string;
};

type CampaignReplyFilter = {
  replyHandling?: 'default' | 'journey' | 'ai_agent';
  replyJourneyId?: string;
  replyAgentId?: string;
};

/**
 * Whether an unassigned conversation's next inbound message should be routed
 * to a specific journey/AI agent because the contact recently received a
 * campaign configured that way — instead of default auto-assign/reply.
 */
export async function resolveCampaignReplyRoute(
  workspaceId: string,
  contactId: string
): Promise<CampaignReplyRoute | null> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { lastCampaignId: true, lastCampaignAt: true },
  });
  if (!contact?.lastCampaignId || !contact.lastCampaignAt) return null;

  const age = Date.now() - contact.lastCampaignAt.getTime();
  if (age > CAMPAIGN_REPLY_ROUTING_WINDOW_MS) return null;

  const campaign = await prisma.campaign.findFirst({
    where: { id: contact.lastCampaignId, workspaceId },
    select: { audienceFilter: true },
  });
  if (!campaign?.audienceFilter || typeof campaign.audienceFilter !== 'object') return null;

  const filter = campaign.audienceFilter as CampaignReplyFilter;
  if (filter.replyHandling === 'journey' && filter.replyJourneyId) {
    return { assigneeType: 'journey', assigneeId: filter.replyJourneyId, campaignId: contact.lastCampaignId };
  }
  if (filter.replyHandling === 'ai_agent' && filter.replyAgentId) {
    return { assigneeType: 'ai_agent', assigneeId: filter.replyAgentId, campaignId: contact.lastCampaignId };
  }
  return null;
}
