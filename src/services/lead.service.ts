import { prisma } from '../index.js';
import type { Prisma } from '@prisma/client';
import { logSocialListeningActivity } from './socialListeningActivity.service.js';
import {
  assertFunnelInWorkspace,
  assertStageInFunnel,
  getDefaultStageForFunnel,
} from './leadFunnel.service.js';
import { phoneForLeadContact } from './leadContactPhone.js';
import {
  buildLeadJourneySnapshot,
  mergeLeadJourneyIntoCustomFields,
  parseLeadJourneyFromCustomFields,
} from './leadJourney.js';
import { resolveContactIdentityFields } from './leadIdentity.js';

export { phoneForLeadContact } from './leadContactPhone.js';
export { resolveContactIdentityFields } from './leadIdentity.js';

export type LeadActivityItem = {
  id: string;
  type: 'stage_change' | 'dm_sent' | 'note' | 'created' | 'converted';
  text: string;
  at: string;
  fromStage?: string;
  toStage?: string;
  stageId?: string;
};

function asActivity(raw: unknown): LeadActivityItem[] {
  if (!Array.isArray(raw)) return [];
  return raw as LeadActivityItem[];
}

export function toPublicLead(row: {
  id: string;
  funnelId?: string | null;
  stageId?: string | null;
  contactId?: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  source: string;
  requirement: string;
  notes: string;
  originUsername: string | null;
  originCommentText: string | null;
  originPostThumbnailUrl: string | null;
  originPostCaption: string | null;
  originCommentedAt: Date | null;
  activity: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  const hasOrigin = Boolean(
    row.originUsername || row.originCommentText || row.originPostCaption
  );
  return {
    id: row.id,
    funnelId: row.funnelId ?? null,
    stageId: row.stageId ?? null,
    contactId: row.contactId ?? null,
    name: row.name,
    phone: row.phone,
    email: row.email,
    stage: row.stage,
    source: (row.source as 'instagram' | 'manual' | 'whatsapp') || 'instagram',
    requirement: row.requirement,
    assignedRep: null as null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    origin: hasOrigin
      ? {
          username: row.originUsername || 'instagram_user',
          commentText: row.originCommentText || '',
          postThumbnailUrl: row.originPostThumbnailUrl || '',
          postCaption: row.originPostCaption || '',
          commentedAt: (row.originCommentedAt || row.createdAt).toISOString(),
        }
      : null,
    notes: row.notes,
    activity: asActivity(row.activity),
  };
}

/** Create lead from an approved interested SocialComment (idempotent on socialComment.leadId). */
export async function createLeadFromSocialComment(input: {
  workspaceId: string;
  socialCommentId: string;
  funnelId: string;
  dmSent?: boolean;
}): Promise<{ leadId: string; created: boolean }> {
  if (!(await assertFunnelInWorkspace(input.workspaceId, input.funnelId))) {
    throw new Error('Funnel not found — create a lead funnel first');
  }

  const comment = await prisma.socialComment.findFirst({
    where: { id: input.socialCommentId, workspaceId: input.workspaceId },
  });
  if (!comment) throw new Error('Comment not found');

  if (comment.leadId) {
    return { leadId: comment.leadId, created: false };
  }

  // Same IG user already a lead → attach this comment (and siblings) instead of duplicating.
  if (comment.commenterUsername?.trim()) {
    const existing = await prisma.lead.findFirst({
      where: {
        workspaceId: input.workspaceId,
        originUsername: { equals: comment.commenterUsername.trim(), mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) {
      await prisma.socialComment.update({
        where: { id: comment.id },
        data: { leadId: existing.id },
      });
      await linkCommenterCommentsToLead(
        input.workspaceId,
        comment.commenterUsername,
        existing.id
      );
      return { leadId: existing.id, created: false };
    }
  }

  const defaultStage = await getDefaultStageForFunnel(input.funnelId);

  const now = new Date().toISOString();
  const activity: LeadActivityItem[] = [
    {
      id: `act-${Date.now()}-created`,
      type: 'created',
      text: 'Lead created from Instagram comment',
      at: now,
    },
  ];
  if (input.dmSent) {
    activity.unshift({
      id: `act-${Date.now()}-dm`,
      type: 'dm_sent',
      text: 'Private DM sent via Approve & Send DM',
      at: now,
    });
  }

  const lead = await prisma.lead.create({
    data: {
      workspaceId: input.workspaceId,
      funnelId: input.funnelId,
      stageId: defaultStage.id,
      stage: defaultStage.name,
      name: comment.commenterUsername ? `@${comment.commenterUsername}` : null,
      source: 'instagram',
      requirement: comment.commentText.slice(0, 500),
      notes: '',
      originUsername: comment.commenterUsername,
      originCommentText: comment.commentText,
      originPostThumbnailUrl: comment.postThumbnailUrl,
      originPostCaption: comment.postCaption,
      originCommentedAt: comment.commentedAt,
      activity: activity as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.socialComment.update({
    where: { id: comment.id },
    data: { leadId: lead.id },
  });
  await linkCommenterCommentsToLead(
    input.workspaceId,
    comment.commenterUsername,
    lead.id
  );

  console.info('[lead.create] from social comment', {
    leadId: lead.id,
    funnelId: input.funnelId,
    stageId: defaultStage.id,
    socialCommentId: comment.id,
    workspaceId: input.workspaceId,
  });

  const handle = comment.commenterUsername
    ? `@${comment.commenterUsername}`
    : 'a commenter';
  await logSocialListeningActivity({
    workspaceId: input.workspaceId,
    eventType: 'lead_created',
    message: `Lead created from ${handle}'s comment`,
    relatedCommentId: comment.id,
    relatedLeadId: lead.id,
  });

  return { leadId: lead.id, created: true };
}

/** Attach leadId to every SocialComment from this IG handle (workspace-wide). */
export async function linkCommenterCommentsToLead(
  workspaceId: string,
  commenterUsername: string | null | undefined,
  leadId: string
): Promise<void> {
  const name = commenterUsername?.trim();
  if (!name) return;
  await prisma.socialComment.updateMany({
    where: {
      workspaceId,
      commenterUsername: { equals: name, mode: 'insensitive' },
      leadId: null,
    },
    data: { leadId },
  });
}

export async function listLeads(
  workspaceId: string,
  opts?: { source?: string; funnelId?: string }
) {
  if (!opts?.funnelId) {
    return [];
  }

  const rows = await prisma.lead.findMany({
    where: {
      workspaceId,
      funnelId: opts.funnelId,
      ...(opts?.source && opts.source !== 'all' ? { source: opts.source } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  return rows.map(toPublicLead);
}

/**
 * Create or re-link a funnel lead for an inbox contact (journey "Add to Funnel").
 * Idempotent on (contactId, funnelId).
 */
export async function upsertLeadForContact(input: {
  workspaceId: string;
  contactId: string;
  funnelId: string;
  stageId?: string;
  source?: 'whatsapp' | 'instagram' | 'manual';
}): Promise<{ leadId: string; created: boolean }> {
  if (!(await assertFunnelInWorkspace(input.workspaceId, input.funnelId))) {
    throw new Error('Funnel not found — create a lead funnel first');
  }

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId: input.workspaceId },
    select: { id: true, name: true, email: true, phone: true, customFields: true },
  });
  if (!contact) throw new Error('Contact not found');

  let stage =
    input.stageId && (await assertStageInFunnel(input.funnelId, input.stageId));
  if (!stage) {
    stage = await getDefaultStageForFunnel(input.funnelId);
  }

  const identity = resolveContactIdentityFields(contact);
  const source = input.source ?? 'manual';

  const existing = await prisma.lead.findFirst({
    where: {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      funnelId: input.funnelId,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    const updated = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        stageId: stage.id,
        stage: stage.name,
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.phone ? { phone: identity.phone } : {}),
        source: existing.source || source,
      },
    });
    return { leadId: updated.id, created: false };
  }

  const now = new Date().toISOString();
  const activity: LeadActivityItem[] = [
    {
      id: `act-${Date.now()}-created`,
      type: 'created',
      text: 'Lead created from automation (Add to Funnel)',
      at: now,
    },
  ];

  const lead = await prisma.lead.create({
    data: {
      workspaceId: input.workspaceId,
      funnelId: input.funnelId,
      stageId: stage.id,
      stage: stage.name,
      contactId: contact.id,
      name: identity.name ?? contact.name ?? null,
      email: identity.email ?? null,
      phone: identity.phone ?? null,
      source,
      requirement: '',
      notes: '',
      activity: activity as unknown as Prisma.InputJsonValue,
    },
  });

  return { leadId: lead.id, created: true };
}

/** Copy contact name/email/phone onto every lead linked to this contact. */
export async function syncLinkedLeadsFromContact(contactId: string): Promise<number> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      email: true,
      phone: true,
      customFields: true,
    },
  });
  if (!contact) return 0;

  const identity = resolveContactIdentityFields(contact);
  if (!identity.name && !identity.email && !identity.phone) return 0;

  const result = await prisma.lead.updateMany({
    where: { contactId: contact.id, workspaceId: contact.workspaceId },
    data: {
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.phone ? { phone: identity.phone } : {}),
    },
  });
  return result.count;
}

export async function updateLead(
  workspaceId: string,
  leadId: string,
  patch: {
    stage?: string;
    stageId?: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    requirement?: string;
    notes?: string;
  }
) {
  const existing = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
  });
  if (!existing) throw new Error('Lead not found');

  const activity = asActivity(existing.activity);
  let nextStageId = existing.stageId;
  let nextStageName = existing.stage;

  const requestedStageId = patch.stageId ?? patch.stage;
  if (requestedStageId && existing.funnelId) {
    const stage = await assertStageInFunnel(existing.funnelId, requestedStageId);
    if (!stage) throw new Error('Board not found in this funnel');
    if (stage.id !== existing.stageId) {
      activity.unshift({
        id: `act-${Date.now()}-stage`,
        type: 'stage_change',
        text: `Moved from ${existing.stage} → ${stage.name}`,
        at: new Date().toISOString(),
        fromStage: existing.stage,
        toStage: stage.name,
        stageId: stage.id,
      });
      nextStageId = stage.id;
      nextStageName = stage.name;
    }
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      ...(requestedStageId
        ? { stageId: nextStageId, stage: nextStageName }
        : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.requirement !== undefined ? { requirement: patch.requirement } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      activity: activity as unknown as Prisma.InputJsonValue,
    },
  });

  return toPublicLead(updated);
}

/** Convert a lead on a final board into a Contact (idempotent via lead.contactId). */
export async function convertLeadToContact(workspaceId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
    include: {
      funnelStage: true,
      funnel: { select: { id: true, name: true } },
    },
  });
  if (!lead) throw new Error('Lead not found');
  if (lead.contactId) {
    const existing = await prisma.contact.findFirst({
      where: { id: lead.contactId, workspaceId },
    });
    if (existing) {
      return {
        lead: toPublicLead(lead),
        contactId: existing.id,
        created: false,
        journey: parseLeadJourneyFromCustomFields(existing.customFields),
      };
    }
  }
  if (!lead.funnelStage?.isFinal) {
    throw new Error('Move the lead to a final board before converting to a contact');
  }

  const phone = phoneForLeadContact(lead);
  const name =
    lead.name?.trim() ||
    (lead.originUsername ? `@${lead.originUsername}` : null) ||
    'Lead contact';
  const source =
    lead.source === 'instagram'
      ? 'Instagram'
      : lead.source === 'whatsapp'
        ? 'WhatsApp'
        : 'Lead';

  let contact = await prisma.contact.findFirst({
    where: { workspaceId, phone },
  });
  let created = false;
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        workspaceId,
        name,
        phone,
        email: lead.email?.trim() || null,
        source,
        tags: ['lead'],
      },
    });
    created = true;
  }

  const convertedAt = new Date().toISOString();
  const activity = asActivity(lead.activity);
  activity.unshift({
    id: `act-${Date.now()}-converted`,
    type: 'converted',
    text: created
      ? `Converted to contact ${name}`
      : `Linked to existing contact ${name}`,
    at: convertedAt,
    toStage: lead.stage,
  });

  const journey = buildLeadJourneySnapshot({
    lead,
    funnelName: lead.funnel?.name || 'Lead funnel',
    convertedAt,
    activity,
  });

  const updatedContact = await prisma.contact.update({
    where: { id: contact.id },
    data: {
      customFields: mergeLeadJourneyIntoCustomFields(
        contact.customFields,
        journey
      ) as Prisma.InputJsonValue,
      ...(!contact.source || contact.source === 'Manual' ? { source } : {}),
      tags: contact.tags.includes('lead') ? contact.tags : [...contact.tags, 'lead'],
    },
  });

  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: {
      contactId: updatedContact.id,
      activity: activity as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    lead: toPublicLead(updated),
    contactId: updatedContact.id,
    created,
    journey,
  };
}
