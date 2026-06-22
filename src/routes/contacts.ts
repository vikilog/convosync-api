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

export default async function contactRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/stats', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const [all, unsubscribe, blocklist] = await Promise.all([
      prisma.contact.count({ where: { workspaceId } }),
      prisma.contact.count({
        where: { workspaceId, tags: { has: LIST_TAGS.unsubscribe } },
      }),
      prisma.contact.count({
        where: { workspaceId, tags: { has: LIST_TAGS.blocklist } },
      }),
    ]);
    return { all, unsubscribe, blocklist };
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
    const { search, tag, list, channel } = request.query as {
      search?: string;
      tag?: string;
      list?: ContactListFilter;
      channel?: ContactChannelFilter;
    };

    const listFilter = listWhere(workspaceId, list);
    const channelFilter =
      channel === 'whatsapp' || channel === 'instagram' || channel === 'messenger'
        ? contactChannelWhere(channel)
        : undefined;

    return prisma.contact.findMany({
      where: {
        ...listFilter,
        ...(channelFilter ?? {}),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { source: { contains: search, mode: 'insensitive' } },
          ],
        }),
        ...(tag && { tags: { has: tag } }),
      },
      orderBy: { updatedAt: 'desc' },
    });
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
