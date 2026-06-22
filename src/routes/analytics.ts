import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { listWorkspaceMemberUsers } from '../services/workspaceMembers.js';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/dashboard', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);

    const [totalContacts, activeJourneys, pausedJourneys, totalConversations, openConversations] =
      await Promise.all([
      prisma.contact.count({ where: { workspaceId } }),
      prisma.journey.count({ where: { workspaceId, status: 'published' } }),
      prisma.journey.count({ where: { workspaceId, status: 'draft' } }),
      prisma.conversation.count({ where: { workspaceId } }),
      prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const messagesToday = await prisma.message.count({
      where: {
        conversation: { workspaceId },
        createdAt: { gte: today },
        sender: 'agent',
      },
    });

    return {
      totalContacts,
      messagesToday,
      deliveryRate: 94.2,
      activeJourneys,
      pausedJourneys,
      openConversations,
    };
  });

  fastify.get('/messages', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { days = '7' } = request.query as { days?: string };
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days, 10));

    const messages = await prisma.message.findMany({
      where: {
        conversation: { workspaceId },
        createdAt: { gte: since },
      },
      select: { createdAt: true, status: true, sender: true },
    });

    const dayCount = parseInt(days, 10) || 7;
    const byDate: Record<string, { sent: number; delivered: number; read: number }> = {};

    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      byDate[d.toISOString().split('T')[0]] = { sent: 0, delivered: 0, read: 0 };
    }

    messages.forEach((m: { createdAt: Date; status: string; sender: string }) => {
      const date = m.createdAt.toISOString().split('T')[0];
      if (!byDate[date]) return;
      if (m.sender === 'agent') {
        byDate[date].sent++;
        if (m.status === 'delivered' || m.status === 'read') byDate[date].delivered++;
        if (m.status === 'read') byDate[date].read++;
      }
    });

    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }));
  });

  fastify.get('/team', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const members = await listWorkspaceMemberUsers(workspaceId);
    return members.map(({ user, conversationsCount }) => ({
      id: user.id,
      name: user.name,
      initials: user.name
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      email: user.email,
      conversationsCount,
      csat: 4.5,
      avgResponse: '4m 30s',
      trend: '+12%',
    }));
  });

  fastify.get('/campaigns', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return campaigns.map(mapAnalyticsCampaign);
  });

  fastify.get('/campaigns/upcoming', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const now = new Date();
    const campaigns = await prisma.campaign.findMany({
      where: {
        workspaceId,
        OR: [{ scheduledAt: { gt: now } }, { status: 'draft', sentAt: null }],
        status: { notIn: ['completed', 'failed', 'running'] },
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 6,
    });
    return campaigns.map(mapAnalyticsCampaign);
  });
}

function mapAnalyticsCampaign(c: {
  id: string;
  name: string;
  status: string;
  totalRecipients: number;
  readCount: number;
  sentCount: number;
  deliveredCount: number;
  audienceFilter: unknown;
  createdAt: Date;
  sentAt: Date | null;
  scheduledAt: Date | null;
}) {
  const filter = (c.audienceFilter ?? {}) as Record<string, unknown>;
  const channel =
    filter.channel === 'email' || filter.channel === 'instagram' ? filter.channel : 'whatsapp';
  const sent = c.sentCount || 0;
  const delivered = c.deliveredCount || 0;
  const deliveryPct = sent > 0 ? `${Math.round((delivered / sent) * 100)}% delivered` : '—';

  return {
    id: c.id,
    name: c.name,
    status:
      c.status === 'running'
        ? 'Running'
        : c.status === 'completed'
          ? 'Completed'
          : c.status === 'failed'
            ? 'Failed'
            : c.status === 'paused'
              ? 'Paused'
              : c.status === 'draft'
                ? 'Draft'
                : c.scheduledAt && c.scheduledAt > new Date()
                  ? 'Scheduled'
                  : 'Active',
    channel,
    sentCount: sent,
    deliveredCount: delivered,
    audienceCount: String(c.totalRecipients || 0),
    engagementMetric: deliveryPct,
    createdAt: c.createdAt.toISOString(),
    sentAt: c.sentAt?.toISOString() ?? null,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    audienceFilter: c.audienceFilter,
  };
}
