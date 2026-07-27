import { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
import { deleteConversationThread } from '../services/conversation-delete.service.js';

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

  fastify.get('/tags', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const rows = await prisma.contact.findMany({
      where: { workspaceId },
      select: { tags: true },
    });
    const tags = [...new Set(rows.flatMap((r) => r.tags))].filter(Boolean).sort((a, b) => a.localeCompare(b));
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
    const { channel, segmentId } = request.query as { channel?: string; segmentId?: string };
    const resolvedChannel: CampaignAudienceChannel =
      channel === 'email' || channel === 'instagram' ? channel : 'whatsapp';
    const resolvedSegment = segmentId?.trim() || 'all';
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
    const contact = await prisma.contact.create({
      data: companyScopedData(workspaceId, {
        ...rest,
        email: email && email.length > 0 ? email : undefined,
        customFields: Object.keys(customFields).length ? customFields : undefined,
      }),
    });

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
    const { workspaceId } = getJwtUser(request);
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

    for (let i = 0; i < body.contacts.length; i++) {
      const row = body.contacts[i];
      const phone = row.phone.trim();
      const emailRaw = row.email?.trim() ?? '';
      if (emailRaw && !z.string().email().safeParse(emailRaw).success) {
        errors.push({ row: i + 1, phone, error: 'Invalid email' });
        continue;
      }
      const email = emailRaw.length > 0 ? emailRaw : undefined;
      const tags = row.tags?.map((t) => t.trim()).filter(Boolean) ?? [];
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

    return reply.send({ created, updated, skipped: errors.length, errors });
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({ where: { id, workspaceId } });
    if (!contact) return reply.code(404).send({ error: 'Not found' });
    return contact;
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

  fastify.put('/:id', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    await prisma.contact.updateMany({
      where: { id, workspaceId },
      data: scopedUpdateData((request.body ?? {}) as Record<string, unknown>),
    });
    const contact = await prisma.contact.findFirst({ where: { id, workspaceId } });
    if (contact) {
      getIo().to(workspaceId).emit('contact_updated', {
        contactId: id,
        tags: contact.tags,
        name: contact.name,
      });
    }
    return contact;
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    const contact = await prisma.contact.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!contact) return reply.code(404).send({ error: 'Not found' });

    const conversations = await prisma.conversation.findMany({
      where: { workspaceId, contactId: id },
      select: { id: true },
    });

    for (const conv of conversations) {
      await deleteConversationThread(workspaceId, conv.id);
      getIo().to(workspaceId).emit('conversation_deleted', { conversationId: conv.id });
    }
    await prisma.agentFlowSession.deleteMany({ where: { workspaceId, contactId: id } });
    await prisma.journeyExecution.deleteMany({ where: { contactId: id } });
    await prisma.contact.delete({ where: { id } });
    getIo().to(workspaceId).emit('contact_deleted', { contactId: id });

    return { success: true, deletedConversations: conversations.length };
  });
}
