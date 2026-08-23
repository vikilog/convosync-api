import { prisma } from '../index.js';
import { Prisma } from '@prisma/client';
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
import { findOrCreateInstagramContact } from '../lib/instagramContact.js';
import { findOrCreateMessengerContact } from '../lib/messengerContact.js';
import { eventBus } from '../modules/journey/events/event-bus.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

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

  // Resolve the SAME Contact identity the inbound webhook handler already
  // creates for this commenter (ensureSocialCommentContact /
  // findOrCreateInstagramContact / findOrCreateMessengerContact) so the
  // lead is linked to a real contact from creation — not left to fall back
  // to a synthetic ig:lead:{id} phone at conversion time that can never
  // match the real one.
  let contactId: string | null = null;
  if (comment.commenterId?.trim()) {
    const id = comment.commenterId.trim();
    if (comment.platform === 'facebook') {
      const contact = await findOrCreateMessengerContact({
        db: prisma,
        workspaceId: input.workspaceId,
        psid: id,
        name: comment.commenterUsername?.trim() || `Facebook ${id.slice(-6)}`,
      });
      contactId = contact.id;
    } else {
      const contact = await findOrCreateInstagramContact({
        db: prisma,
        workspaceId: input.workspaceId,
        scopedUserId: id,
        name: comment.commenterUsername?.trim()
          ? `@${comment.commenterUsername.replace(/^@/, '')}`
          : undefined,
      });
      contactId = contact.id;
    }
  }

  // Same-person dedup: contactId is the reliable identity — the same key
  // upsertLeadForContact (the "Add to Funnel" journey action) already
  // dedupes on, so a lead created via either path is found by the other.
  // Username is only a fallback for comments captured before commenterId
  // was tracked.
  const existing = contactId
    ? await prisma.lead.findFirst({
        where: { workspaceId: input.workspaceId, contactId, funnelId: input.funnelId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
    : comment.commenterUsername?.trim()
      ? await prisma.lead.findFirst({
          where: {
            workspaceId: input.workspaceId,
            originUsername: { equals: comment.commenterUsername.trim(), mode: 'insensitive' },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;

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

  const defaultStage = await getDefaultStageForFunnel(input.funnelId);

  const now = new Date().toISOString();
  const activity: LeadActivityItem[] = [
    {
      id: `act-${Date.now()}-created`,
      type: 'created',
      text: `Lead created from ${comment.platform === 'facebook' ? 'Facebook' : 'Instagram'} comment`,
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

  const leadData: Prisma.LeadUncheckedCreateInput = {
    workspaceId: input.workspaceId,
    funnelId: input.funnelId,
    stageId: defaultStage.id,
    stage: defaultStage.name,
    contactId,
    name: comment.commenterUsername ? `@${comment.commenterUsername}` : null,
    source: comment.platform,
    requirement: comment.commentText.slice(0, 500),
    notes: '',
    originUsername: comment.commenterUsername,
    originCommentText: comment.commentText,
    originPostThumbnailUrl: comment.postThumbnailUrl,
    originPostCaption: comment.postCaption,
    originCommentedAt: comment.commentedAt,
    activity: activity as unknown as Prisma.InputJsonValue,
  };

  let lead: { id: string };
  try {
    lead = await prisma.lead.create({ data: leadData });
  } catch (err) {
    if (!isPrismaUniqueViolation(err) || !contactId) throw err;
    // A concurrent request for the same commenter (e.g. two comments
    // arriving as separate webhook deliveries seconds apart) already
    // created the lead for this (workspace, contact, funnel) — attach this
    // comment to that lead instead of crashing.
    const winner = await prisma.lead.findFirst({
      where: { workspaceId: input.workspaceId, contactId, funnelId: input.funnelId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!winner) throw err;
    await prisma.socialComment.update({
      where: { id: comment.id },
      data: { leadId: winner.id },
    });
    await linkCommenterCommentsToLead(input.workspaceId, comment.commenterUsername, winner.id);
    return { leadId: winner.id, created: false };
  }

  // Atomic claim — the comment.leadId read at the top of this function is a
  // plain read, racy against a fast double-click on "Add to lead" (no
  // ref-guard on the frontend) or two independent requests for the same
  // comment. Without this, both calls could pass that check, both create a
  // separate Lead row here, and this plain update would just silently
  // overwrite whichever one wrote last — leaving an orphaned duplicate lead.
  const claim = await prisma.socialComment.updateMany({
    where: { id: comment.id, workspaceId: input.workspaceId, leadId: null },
    data: { leadId: lead.id },
  });
  if (claim.count === 0) {
    const winnerComment = await prisma.socialComment.findUnique({
      where: { id: comment.id },
      select: { leadId: true },
    });
    await prisma.lead.delete({ where: { id: lead.id } }).catch(() => {});
    if (winnerComment?.leadId) {
      return { leadId: winnerComment.leadId, created: false };
    }
    throw new Error('Failed to link lead to comment');
  }
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

  try {
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
  } catch (err) {
    if (!isPrismaUniqueViolation(err)) throw err;
    // Two overlapping journey executions (or a race with a manual/social
    // lead capture) for the same contact both passed the findFirst check
    // above — the partial unique index on (workspaceId, contactId,
    // funnelId) caught the second create; use the winner's row instead of
    // duplicating the lead.
    const winner = await prisma.lead.findFirst({
      where: { workspaceId: input.workspaceId, contactId: input.contactId, funnelId: input.funnelId },
      orderBy: { createdAt: 'desc' },
    });
    if (!winner) throw err;
    return { leadId: winner.id, created: false };
  }
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

  let nextStageId = existing.stageId;
  let nextStageName = existing.stage;
  let newActivityEntry: LeadActivityItem | null = null;

  const requestedStageId = patch.stageId ?? patch.stage;
  if (requestedStageId && existing.funnelId) {
    const stage = await assertStageInFunnel(existing.funnelId, requestedStageId);
    if (!stage) throw new Error('Board not found in this funnel');
    if (stage.id !== existing.stageId) {
      newActivityEntry = {
        id: `act-${Date.now()}-stage`,
        type: 'stage_change',
        text: `Moved from ${existing.stage} → ${stage.name}`,
        at: new Date().toISOString(),
        fromStage: existing.stage,
        toStage: stage.name,
        stageId: stage.id,
      };
      nextStageId = stage.id;
      nextStageName = stage.name;
    }
  }

  // The activity log is prepended atomically at the DB level (JSONB
  // concatenation), not via read-modify-write of the whole array — two
  // concurrent stage moves on the same lead each reading the same starting
  // `activity` would otherwise have the second write's full-array overwrite
  // silently discard the first mover's log entry.
  const statements: Prisma.PrismaPromise<unknown>[] = [];
  if (newActivityEntry) {
    statements.push(
      prisma.$executeRaw`
        UPDATE "Lead"
        SET activity = ${JSON.stringify([newActivityEntry])}::jsonb || activity
        WHERE id = ${leadId} AND "workspaceId" = ${workspaceId}
      `
    );
  }
  statements.push(
    prisma.lead.update({
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
      },
    })
  );

  const results = await prisma.$transaction(statements);
  const updated = results[results.length - 1] as Awaited<ReturnType<typeof prisma.lead.update>>;

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
    try {
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
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      // Same race already fixed for WhatsApp/IG/Messenger contact creation
      // — a concurrent convert (or an inbound message for the same phone)
      // won the create; use their row instead of crashing.
      contact = await prisma.contact.findFirst({ where: { workspaceId, phone } });
      if (!contact) throw err;
    }
  }

  // Atomic claim: only the FIRST of two concurrent convert calls for this
  // lead gets to write contactId + append the "Converted" activity entry.
  // A losing call (double-click, or two requests racing) returns the
  // winner's already-committed result instead of duplicating the activity
  // entry or redundantly re-writing the contact.
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

  const claim = await prisma.lead.updateMany({
    where: { id: lead.id, contactId: null },
    data: { contactId: contact.id, activity: activity as unknown as Prisma.InputJsonValue },
  });

  if (claim.count === 0) {
    const winnerLead = await prisma.lead.findFirst({ where: { id: lead.id, workspaceId } });
    const winnerContact = winnerLead?.contactId
      ? await prisma.contact.findFirst({ where: { id: winnerLead.contactId, workspaceId } })
      : null;
    if (winnerLead && winnerContact) {
      return {
        lead: toPublicLead(winnerLead),
        contactId: winnerContact.id,
        created: false,
        journey: parseLeadJourneyFromCustomFields(winnerContact.customFields),
      };
    }
    throw new Error('Lead was converted by another request');
  }

  const hadLeadTag = contact.tags.includes('lead');
  const updatedContact = await prisma.contact.update({
    where: { id: contact.id },
    data: {
      customFields: mergeLeadJourneyIntoCustomFields(
        contact.customFields,
        journey
      ) as Prisma.InputJsonValue,
      ...(!contact.source || contact.source === 'Manual' ? { source } : {}),
      tags: hadLeadTag ? contact.tags : [...contact.tags, 'lead'],
    },
  });

  // Same events routes/contacts.ts emits on its own create/tag paths —
  // without these, a journey on "Contact created" or a developer webhook on
  // new contacts got zero runs for the primary way Instagram/WhatsApp leads
  // enter the CRM. Only the CAS winner (this point is unreached by a loser)
  // emits, so a losing concurrent request can't double-fire either event.
  if (created) {
    void eventBus.emit('contact.created', {
      workspaceId,
      event: 'contact.created',
      contactId: updatedContact.id,
      payload: { source: updatedContact.source ?? undefined },
    });
  }
  if (!hadLeadTag) {
    void eventBus.emit('contact.tag_added', {
      workspaceId,
      event: 'contact.tag_added',
      contactId: updatedContact.id,
      payload: { tags: ['lead'] },
    });
  }

  const updatedLead = await prisma.lead.findFirst({ where: { id: lead.id, workspaceId } });

  return {
    lead: toPublicLead(updatedLead ?? lead),
    contactId: updatedContact.id,
    created,
    journey,
  };
}
