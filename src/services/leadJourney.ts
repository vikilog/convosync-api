export type LeadJourneyTimelineItem = {
  at: string;
  type: string;
  text: string;
  fromStage?: string;
  toStage?: string;
};

type ActivityLike = {
  at: string;
  type: string;
  text: string;
  fromStage?: string;
  toStage?: string;
};

/** Immutable copy of funnel path stored on Contact.customFields.leadJourney (JSON string). */
export type LeadJourneySnapshot = {
  version: 1;
  leadId: string;
  funnelId: string | null;
  funnelName: string;
  enteredAt: string;
  convertedAt: string;
  finalStage: string;
  source: string;
  origin: {
    username: string;
    commentText: string;
    postCaption: string;
  } | null;
  timeline: LeadJourneyTimelineItem[];
};

export const LEAD_JOURNEY_FIELD = 'leadJourney';

export function buildLeadJourneySnapshot(input: {
  lead: {
    id: string;
    funnelId: string | null;
    stage: string;
    source: string;
    createdAt: Date;
    originUsername: string | null;
    originCommentText: string | null;
    originPostCaption: string | null;
  };
  funnelName: string;
  convertedAt?: string;
  activity: ActivityLike[];
}): LeadJourneySnapshot {
  const convertedAt = input.convertedAt || new Date().toISOString();
  const timeline: LeadJourneyTimelineItem[] = input.activity
    .map((a) => ({
      at: a.at,
      type: a.type,
      text: a.text,
      fromStage: a.fromStage,
      toStage: a.toStage,
    }))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const hasOrigin = Boolean(
    input.lead.originUsername || input.lead.originCommentText || input.lead.originPostCaption
  );

  return {
    version: 1,
    leadId: input.lead.id,
    funnelId: input.lead.funnelId,
    funnelName: input.funnelName,
    enteredAt: input.lead.createdAt.toISOString(),
    convertedAt,
    finalStage: input.lead.stage,
    source: input.lead.source,
    origin: hasOrigin
      ? {
          username: input.lead.originUsername || 'instagram_user',
          commentText: input.lead.originCommentText || '',
          postCaption: input.lead.originPostCaption || '',
        }
      : null,
    timeline,
  };
}

export function parseLeadJourneyFromCustomFields(
  customFields: unknown
): LeadJourneySnapshot | null {
  if (!customFields || typeof customFields !== 'object') return null;
  const raw = (customFields as Record<string, unknown>)[LEAD_JOURNEY_FIELD];
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
    return parsed as LeadJourneySnapshot;
  } catch {
    return null;
  }
}

export function mergeLeadJourneyIntoCustomFields(
  existing: unknown,
  snapshot: LeadJourneySnapshot
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  // ponytail: string so contact create/update zod z.record(z.string()) won't strip it later
  base[LEAD_JOURNEY_FIELD] = JSON.stringify(snapshot);
  return base;
}

/** Prefer snapshot on contact; fall back to linked Lead activity. */
export async function getContactLeadJourney(
  workspaceId: string,
  contactId: string
): Promise<LeadJourneySnapshot | null> {
  const { prisma } = await import('../index.js');
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true, customFields: true },
  });
  if (!contact) return null;

  const fromFields = parseLeadJourneyFromCustomFields(contact.customFields);
  if (fromFields) return fromFields;

  const lead = await prisma.lead.findFirst({
    where: { workspaceId, contactId },
    include: { funnel: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!lead) return null;

  const activity = Array.isArray(lead.activity) ? (lead.activity as ActivityLike[]) : [];
  const converted = activity.find((a) => a.type === 'converted');
  return buildLeadJourneySnapshot({
    lead,
    funnelName: lead.funnel?.name || 'Lead funnel',
    convertedAt: converted?.at || lead.updatedAt.toISOString(),
    activity,
  });
}
