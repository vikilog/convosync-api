import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, companyScopedData, scopedUpdateData } from '../middleware/workspaceScope.js';
import {
  getCampaignAudienceSegments,
  listCampaignAudienceContacts,
  type CampaignAudienceChannel,
} from '../services/campaignAudience.service.js';
import { eventBus } from '../modules/journey/events/event-bus.js';
import { getIo } from '../socket.js';
import { contactChannelWhere, type ContactChannelFilter } from '../lib/channelContact.js';
import { getContactAudits } from '../services/contact-audit.service.js';
import { getContactLeadJourney } from '../services/leadJourney.js';
import {
  getContactOverview,
  linkContacts,
  listContactLinks,
  unlinkContact,
} from '../services/contactLink.service.js';
import {
  countContactsWithTag,
  deleteContactInWorkspace,
  deleteContactsByTag,
  normalizeContactTag,
} from '../services/contact-delete.service.js';
import { listWorkspaceTags, registerWorkspaceTags } from '../services/workspaceTags.service.js';
import { normalizeWhatsAppContactPhone } from '../lib/whatsappContact.js';

import {
  buildGrowthBuckets,
  resolveGrowthWindow,
  resolveTimeZone,
  type GrowthRangeKey,
} from '../lib/contactGrowth.js';


const LIST_TAGS = {
  unsubscribe: 'Unsubscribed',
  blocklist: 'Blocked',
} as const;

type ContactListFilter = keyof typeof LIST_TAGS | 'all';

function listWhere(workspaceId: string, list?: string) {
  const base = { workspaceId } as { workspaceId: string; tags?: { has: string } };
  if (list === 'unsubscribe') return { ...base, tags: { has: LIST_TAGS.unsubscribe } };
  if (list === 'blocklist') return { ...base, tags: { has: LIST_TAGS.blocklist } };
  return base;
}

function encodeContactCursor(updatedAt: Date, id: string): string {
  return `${updatedAt.toISOString()}|${id}`;
}

function decodeContactCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const i = cursor.indexOf('|');
  if (i < 0) return null;
  const updatedAt = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (Number.isNaN(updatedAt.getTime()) || !id) return null;
  return { updatedAt, id };
}

function parseDayBound(ymd: string | undefined, end: boolean): Date | undefined {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
  return new Date(`${ymd}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

export default async function contactRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/stats', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);

    const [
      all,
      unsubscribe,
      blocklist,
      withEmail,
      whatsapp,
      instagram,
      messenger,
      sourceGroups,
      tagRows,
    ] = await Promise.all([
      prisma.contact.count({ where: { workspaceId } }),
      prisma.contact.count({
        where: { workspaceId, tags: { has: LIST_TAGS.unsubscribe } },
      }),
      prisma.contact.count({
        where: { workspaceId, tags: { has: LIST_TAGS.blocklist } },
      }),
      prisma.contact.count({
        where: {
          workspaceId,
          AND: [{ email: { not: null } }, { email: { not: '' } }],
        },
      }),
      prisma.contact.count({
        where: { workspaceId, ...contactChannelWhere('whatsapp') },
      }),
      prisma.contact.count({
        where: { workspaceId, ...contactChannelWhere('instagram') },
      }),
      prisma.contact.count({
        where: { workspaceId, ...contactChannelWhere('messenger') },
      }),
      prisma.contact.groupBy({
        by: ['source'],
        where: { workspaceId },
        _count: { _all: true },
        orderBy: { _count: { source: 'desc' } },
        take: 8,
      }),
      prisma.contact.findMany({
        where: { workspaceId },
        select: { tags: true },
      }),
    ]);

    const tagCounts = new Map<string, number>();
    for (const row of tagRows) {
      for (const tag of row.tags) {
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count }));

    const sources = sourceGroups.map((g) => ({
      source: g.source?.trim() || 'Unknown',
      count: g._count._all,
    }));

    return {
      all,
      unsubscribe,
      blocklist,
      withEmail,
      channels: { whatsapp, instagram, messenger },
      sources,
      topTags,
    };
  });

  /** New-contacts series for dashboard chart (bucketed in client timezone). */
  fastify.get('/growth', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { range, dateFrom, dateTo, tz } = request.query as {
      range?: GrowthRangeKey | string;
      dateFrom?: string;
      dateTo?: string;
      tz?: string;
    };
    const timeZone = resolveTimeZone(tz);
    const { start, end, mode } = resolveGrowthWindow(range, timeZone, dateFrom, dateTo);
    const rows = await prisma.contact.findMany({
      where: { workspaceId, createdAt: { gte: start, lte: end } },
      select: { createdAt: true },
    });
    const createdByDay = buildGrowthBuckets(rows, start, end, mode, timeZone);
    const total = createdByDay.reduce((s, d) => s + d.count, 0);
    return {
      range:
        range === 'custom'
          ? 'custom'
          : range === 'today' || range === 'yesterday' || range === 'week'
            ? range
            : 'month',
      mode,
      timeZone,
      total,
      createdByDay,
    };
  });

  /** Sourced from the WorkspaceTag registry (Settings → Automation → Tags), folder-grouped order. */
  fastify.get('/tags', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { tags } = await listWorkspaceTags(workspaceId);
    return { tags };
  });

  fastify.get('/campaign-audience', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { channel } = request.query as { channel?: string };
    const resolvedChannel: CampaignAudienceChannel =
      channel === 'email' || channel === 'instagram' ? channel : 'whatsapp';
    return getCampaignAudienceSegments(workspaceId, resolvedChannel);
  });

  fastify.get('/campaign-audience/contacts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { channel, segmentId, segmentIds: segmentIdsRaw } = request.query as {
      channel?: string;
      segmentId?: string;
      segmentIds?: string;
    };
    const resolvedChannel: CampaignAudienceChannel =
      channel === 'email' || channel === 'instagram' ? channel : 'whatsapp';
    let resolvedSegment: string | string[] = segmentId?.trim() || 'all';
    if (segmentIdsRaw?.trim()) {
      try {
        const parsed = JSON.parse(segmentIdsRaw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          resolvedSegment = parsed.map(String);
        }
      } catch {
        // keep segmentId fallback
      }
    }
    return listCampaignAudienceContacts(workspaceId, resolvedChannel, resolvedSegment);
  });

  fastify.get('/segments', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const total = await prisma.contact.count({ where: { workspaceId } });
    return [
      { id: 'all', name: 'All Contacts', count: total, icon: 'users' },
      {
        id: 'hot_leads',
        name: 'Hot Leads',
        count: await prisma.contact.count({ where: { workspaceId, tags: { has: 'Hot' } } }),
        icon: 'flame',
      },
      {
        id: 'students',
        name: 'Students',
        count: await prisma.contact.count({ where: { workspaceId, tags: { has: 'Student' } } }),
        icon: 'graduation-cap',
      },
    ];
  });

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { search, tag, list, channel, cursor, limit: limitRaw, dateFrom, dateTo } =
      request.query as {
        search?: string;
        tag?: string;
        list?: ContactListFilter;
        channel?: ContactChannelFilter;
        cursor?: string;
        limit?: string;
        dateFrom?: string;
        dateTo?: string;
      };

    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 25));
    const listFilter = listWhere(workspaceId, list);
    const channelFilter =
      channel === 'whatsapp' || channel === 'instagram' || channel === 'messenger'
        ? contactChannelWhere(channel)
        : undefined;

    const createdFrom = parseDayBound(dateFrom, false);
    const createdTo = parseDayBound(dateTo, true);
    const createdAt =
      createdFrom || createdTo
        ? {
            ...(createdFrom ? { gte: createdFrom } : {}),
            ...(createdTo ? { lte: createdTo } : {}),
          }
        : undefined;

    const searchOr = search
      ? [
          { name: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { source: { contains: search, mode: 'insensitive' as const } },
        ]
      : undefined;

    const decoded = cursor ? decodeContactCursor(cursor) : null;
    const cursorOr = decoded
      ? [
          { updatedAt: { lt: decoded.updatedAt } },
          { updatedAt: decoded.updatedAt, id: { lt: decoded.id } },
        ]
      : undefined;

    const and: object[] = [];
    if (searchOr) and.push({ OR: searchOr });
    if (cursorOr) and.push({ OR: cursorOr });

    const rows = await prisma.contact.findMany({
      where: {
        ...listFilter,
        ...(channelFilter ?? {}),
        ...(createdAt ? { createdAt } : {}),
        ...(tag && { tags: { has: tag } }),
        ...(and.length ? { AND: and } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? encodeContactCursor(last.updatedAt, last.id) : null;

    return { items, nextCursor, hasMore };
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const schema = z.object({
      name: z.string().min(1),
      phone: z.string().min(5),
      email: z.union([z.string().email(), z.literal('')]).optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
      customFields: z.record(z.string()).optional(),
      ownerId: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { ownerId, email, ...rest } = body;
    const customFields = {
      ...(rest.customFields ?? {}),
      ...(ownerId ? { ownerId } : {}),
    };
    let contact;
    try {
      contact = await prisma.contact.create({
        data: companyScopedData(workspaceId, {
          ...rest,
          email: email && email.length > 0 ? email : undefined,
          customFields: Object.keys(customFields).length ? customFields : undefined,
        }),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: 'A contact with this phone number already exists' });
      }
      throw err;
    }

    if (rest.tags?.length) void registerWorkspaceTags(workspaceId, rest.tags);

    void eventBus.emit('contact.created', {
      workspaceId,
      event: 'contact.created',
      contactId: contact.id,
      payload: { source: contact.source ?? undefined },
    });

    return reply.code(201).send(contact);
  });

  /** Bulk upsert by phone+workspace. Client may chunk large CSVs. */
  fastify.post('/import', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const rowSchema = z.object({
      name: z.string().min(1),
      phone: z.string().min(5),
      email: z.string().optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
    });
    const body = z
      .object({
        contacts: z.array(rowSchema).min(1).max(5000),
      })
      .parse(request.body);

    let created = 0;
    let updated = 0;
    const errors: { row: number; phone: string; error: string }[] = [];
    const allTags = new Set<string>();

    for (let i = 0; i < body.contacts.length; i++) {
      const row = body.contacts[i];
      const rawPhone = row.phone.trim();
      // Normalize to digits-only — same form upsertWhatsAppContact stores —
      // both to reject garbage phone values up front and so an imported
      // contact actually matches a later inbound WhatsApp message instead
      // of creating a duplicate because the formats differ.
      const phone = normalizeWhatsAppContactPhone(rawPhone);
      if (phone.length < 10 || phone.length > 15) {
        errors.push({ row: i + 1, phone: rawPhone, error: 'Invalid phone number' });
        continue;
      }
      const emailRaw = row.email?.trim() ?? '';
      if (emailRaw && !z.string().email().safeParse(emailRaw).success) {
        errors.push({ row: i + 1, phone, error: 'Invalid email' });
        continue;
      }
      const email = emailRaw.length > 0 ? emailRaw : undefined;
      const tags = row.tags?.map((t) => t.trim()).filter(Boolean) ?? [];
      for (const tag of tags) allTags.add(tag);
      const source = row.source?.trim() || 'csv_import';
      try {
        const existing = await prisma.contact.findUnique({
          where: { phone_workspaceId: { phone, workspaceId } },
          select: { id: true, tags: true },
        });
        if (existing) {
          const mergedTags = [...new Set([...existing.tags, ...tags])];
          await prisma.contact.update({
            where: { id: existing.id },
            data: {
              name: row.name.trim(),
              ...(email !== undefined ? { email } : {}),
              source,
              tags: mergedTags,
            },
          });
          updated += 1;
          const addedTags = mergedTags.filter((t) => !existing.tags.includes(t));
          if (addedTags.length) {
            void eventBus.emit('contact.tag_added', {
              workspaceId,
              event: 'contact.tag_added',
              contactId: existing.id,
              payload: { tags: addedTags },
            });
          }
        } else {
          const contact = await prisma.contact.create({
            data: companyScopedData(workspaceId, {
              name: row.name.trim(),
              phone,
              email,
              source,
              tags,
            }),
          });
          created += 1;
          void eventBus.emit('contact.created', {
            workspaceId,
            event: 'contact.created',
            contactId: contact.id,
            payload: { source: contact.source ?? undefined },
          });
        }
      } catch (err) {
        errors.push({
          row: i + 1,
          phone,
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }

    if (allTags.size) void registerWorkspaceTags(workspaceId, [...allTags]);

    const skipped = errors.length;
    void import('../services/notifications/emitNotification.js').then(({ emitNotification }) =>
      import('../services/notifications/types.js').then(({ NOTIFICATION_TYPES }) =>
        emitNotification({
          workspaceId,
          type: NOTIFICATION_TYPES.CONTACT_IMPORT_FINISHED,
          title: 'Contact import finished',
          message: `Imported ${created} new, updated ${updated}${skipped ? `, ${skipped} skipped` : ''}.`,
          entityType: 'contact_import',
          actorUserId: userId,
          metadata: { created, updated, skipped },
        })
      )
    );

    return reply.send({ created, updated, skipped, errors });
  });

  /** Count contacts that have the given tag (for delete-by-tag confirm). Must be before /:id. */
  fastify.get('/by-tag/count', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const tag = normalizeContactTag(String((request.query as { tag?: string }).tag ?? ''));
    if (!tag) return reply.code(400).send({ error: 'tag is required' });
    const count = await countContactsWithTag(workspaceId, tag);
    return { tag, count };
  });

  /** Hard-delete every contact in the workspace that has this tag. Does not delete the tag registry. */
  fastify.delete('/by-tag', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = z.object({ tag: z.string() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'tag is required' });
    const tag = normalizeContactTag(body.data.tag);
    if (!tag) return reply.code(400).send({ error: 'tag is required' });
    const { deleted, failed, errors } = await deleteContactsByTag(workspaceId, tag);
    return { success: failed === 0, tag, deleted, failed, errors };
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({ where: { id, workspaceId } });
    if (!contact) return reply.code(404).send({ error: 'Not found' });
    return contact;
  });

  fastify.get('/:id/lead-journey', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!contact) return reply.code(404).send({ error: 'Not found' });
    const journey = await getContactLeadJourney(workspaceId, id);
    return { journey };
  });

  fastify.get('/:id/links', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const links = await listContactLinks(workspaceId, id);
    if (!links) return reply.code(404).send({ error: 'Not found' });
    return links;
  });

  fastify.post('/:id/links', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = z.object({ otherContactId: z.string().min(1) }).parse(request.body);
    try {
      const links = await linkContacts(workspaceId, id, body.otherContactId);
      if (!links) return reply.code(404).send({ error: 'Not found' });
      return links;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Link failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.delete('/:id/links/:otherContactId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, otherContactId } = request.params as {
      id: string;
      otherContactId: string;
    };
    try {
      const links = await unlinkContact(workspaceId, id, otherContactId);
      if (!links) return reply.code(404).send({ error: 'Not found' });
      return links;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unlink failed';
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get('/:id/overview', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const overview = await getContactOverview(workspaceId, id);
    if (!overview) return reply.code(404).send({ error: 'Not found' });
    return overview;
  });

  fastify.get('/:id/audits', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const audits = await getContactAudits(workspaceId, id);
    if (!audits) return reply.code(404).send({ error: 'Not found' });
    return audits;
  });

  fastify.get('/:id/insights/latest', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({
      where: { id, workspaceId },
      select: { id: true, excludeFromInsights: true },
    });
    if (!contact) return reply.code(404).send({ error: 'Not found' });
    const { getLatestContactInsight } = await import(
      '../modules/contact-insight/contact-insight.service.js'
    );
    const insight = await getLatestContactInsight(workspaceId, id);
    return {
      insight,
      excludeFromInsights: contact.excludeFromInsights,
    };
  });

  /** Manual prepare — force recompute past the 6h gap (existing calls/chats). */
  fastify.post('/:id/insights/compute', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({
      where: { id, workspaceId },
      select: { id: true, excludeFromInsights: true },
    });
    if (!contact) return reply.code(404).send({ error: 'Not found' });
    if (contact.excludeFromInsights) {
      return reply.code(409).send({
        error: 'Contact is excluded from insights',
        code: 'excluded',
      });
    }

    const { enqueueContactInsight } = await import('../queue/contact-insight.queue.js');
    const result = await enqueueContactInsight({
      workspaceId,
      contactId: id,
      reason: 'manual',
      force: true,
    });

    if (!result.queued && result.reason === 'disabled') {
      return reply.code(503).send({ error: 'Contact insight is disabled', code: result.reason });
    }

    return {
      queued: result.queued,
      reason: result.reason ?? null,
      jobId: result.jobId ?? null,
    };
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const schema = z.object({
      name: z.string().min(1).optional(),
      phone: z.string().min(5).optional(),
      email: z.union([z.string().email(), z.null(), z.literal('')]).optional(),
      tags: z.array(z.string()).optional(),
      excludeFromInsights: z.boolean().optional(),
      customFields: z.record(z.string()).optional(),
    });
    // Whitelisted, not just deny-listed: linkGroupId in particular must go
    // through linkContacts/unlinkContact, which enforce the
    // one-contact-per-channel-per-group invariant — a raw PUT here would
    // silently corrupt it.
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    }
    const data: Record<string, unknown> = { ...parsed.data };
    if ('email' in data && data.email === '') data.email = null;

    const before = await prisma.contact.findFirst({ where: { id, workspaceId }, select: { tags: true } });
    if (!before) return reply.code(404).send({ error: 'Not found' });

    await prisma.contact.updateMany({ where: { id, workspaceId }, data });
    if (Array.isArray(data.tags) && data.tags.length) {
      void registerWorkspaceTags(workspaceId, data.tags as string[]);
    }
    const contact = await prisma.contact.findFirst({ where: { id, workspaceId } });
    if (contact) {
      getIo().to(workspaceId).emit('contact_updated', {
        contactId: id,
        tags: contact.tags,
        name: contact.name,
      });
      const addedTags = contact.tags.filter((t) => !before.tags.includes(t));
      if (addedTags.length) {
        void eventBus.emit('contact.tag_added', {
          workspaceId,
          event: 'contact.tag_added',
          contactId: id,
          payload: { tags: addedTags },
        });
      }
    }
    return contact;
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    const result = await deleteContactInWorkspace(workspaceId, id);
    if (!result.deleted) return reply.code(404).send({ error: 'Not found' });

    return { success: true, deletedConversations: result.deletedConversations };
  });
}
