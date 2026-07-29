import { prisma } from '../index.js';

export type ContactAuditEventType =
  | 'journey'
  | 'bot'
  | 'ai'
  | 'campaign'
  | 'template';

export interface ContactAuditSummary {
  journeys: number;
  bots: number;
  aiReplies: number;
  campaigns: number;
  templates: number;
}

export interface ContactAuditEvent {
  id: string;
  type: ContactAuditEventType;
  title: string;
  subtitle?: string;
  status?: string;
  timestamp: string;
  stepCount?: number;
}

export interface ContactAuditResponse {
  contactId: string;
  contactName: string;
  contactPhone: string;
  summary: ContactAuditSummary;
  events: ContactAuditEvent[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function journeyStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function botStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'completed':
      return 'Completed';
    case 'handed_off':
      return 'Handed off to agent';
    default:
      return status;
  }
}

export async function getContactAudits(
  workspaceId: string,
  contactId: string
): Promise<ContactAuditResponse | null> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!contact) return null;

  const conversationIds = (
    await prisma.conversation.findMany({
      where: { contactId, workspaceId },
      select: { id: true },
    })
  ).map((c) => c.id);

  const email = contact.email?.trim() || null;

  const [journeyExecutions, botSessions, automationMessages, emailLogs] = await Promise.all([
    prisma.journeyExecution.findMany({
      where: { contactId, journey: { workspaceId } },
      include: {
        journey: { select: { id: true, name: true } },
        logs: { select: { id: true, status: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    }),
    prisma.agentFlowSession.findMany({
      where: { contactId, workspaceId },
      include: {
        agent: { select: { id: true, name: true, category: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    conversationIds.length
      ? prisma.message.findMany({
          where: {
            conversationId: { in: conversationIds },
            sender: 'agent',
          },
          select: {
            id: true,
            senderName: true,
            type: true,
            metadata: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })
      : Promise.resolve([]),
    prisma.emailLog.findMany({
      where: {
        workspaceId,
        OR: [
          { metadata: { path: ['contactId'], equals: contactId } },
          ...(email
            ? [{ recipient: { equals: email, mode: 'insensitive' as const } }]
            : []),
        ],
      },
      select: {
        id: true,
        status: true,
        recipient: true,
        subject: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ]);

  let aiReplies = 0;
  let botMessages = 0;
  let templateSends = 0;
  const campaignIds = new Set<string>();
  const campaignNames = new Map<string, string>();
  const campaignChannel = new Map<string, 'whatsapp' | 'email'>();
  const campaignEmailStatus = new Map<string, string>();
  const campaignEmailAt = new Map<string, Date>();

  for (const msg of automationMessages) {
    const meta = asRecord(msg.metadata);
    const source = typeof meta.source === 'string' ? meta.source : '';

    if (source === 'ai_copilot') {
      aiReplies += 1;
      continue;
    }
    if (source === 'rule_based_flow') {
      botMessages += 1;
      continue;
    }
    if (typeof meta.campaignId === 'string') {
      campaignIds.add(meta.campaignId);
      campaignChannel.set(meta.campaignId, 'whatsapp');
      const templateName =
        typeof meta.templateName === 'string' ? meta.templateName : 'Campaign message';
      if (!campaignNames.has(meta.campaignId)) {
        campaignNames.set(meta.campaignId, templateName);
      }
      continue;
    }
    if (msg.type === 'template' && !meta.campaignId && source !== 'journey') {
      templateSends += 1;
    }
  }

  for (const log of emailLogs) {
    const meta = asRecord(log.metadata);
    const campaignId = typeof meta.campaignId === 'string' ? meta.campaignId : null;
    if (!campaignId) continue;
    campaignIds.add(campaignId);
    campaignChannel.set(campaignId, 'email');
    if (!campaignNames.has(campaignId)) {
      campaignNames.set(campaignId, log.subject || 'Email campaign');
    }
    const prevAt = campaignEmailAt.get(campaignId);
    if (!prevAt || log.updatedAt > prevAt) {
      campaignEmailAt.set(campaignId, log.updatedAt);
      campaignEmailStatus.set(campaignId, emailLogStatusLabel(log.status));
    }
  }

  const campaignRecords =
    campaignIds.size > 0
      ? await prisma.campaign.findMany({
          where: { id: { in: [...campaignIds] }, workspaceId },
          select: { id: true, name: true, sentAt: true },
        })
      : [];

  const events: ContactAuditEvent[] = [];

  for (const execution of journeyExecutions) {
    const successSteps = execution.logs.filter((l) => l.status === 'success').length;
    events.push({
      id: `journey-${execution.id}`,
      type: 'journey',
      title: execution.journey.name,
      subtitle: `${successSteps} step${successSteps === 1 ? '' : 's'} executed`,
      status: journeyStatusLabel(execution.status),
      timestamp: (execution.lastExecutedAt ?? execution.startedAt).toISOString(),
      stepCount: successSteps,
    });
  }

  for (const session of botSessions) {
    const ctx = asRecord(session.context);
    const restartedAt =
      typeof ctx.restartedAt === 'string' ? ctx.restartedAt : null;
    events.push({
      id: `bot-${session.id}`,
      type: 'bot',
      title: session.agent.name,
      subtitle:
        session.agent.category === 'rule_based' ? 'Rule-based bot' : session.agent.category,
      status: botStatusLabel(session.status),
      timestamp: restartedAt ?? session.updatedAt.toISOString(),
    });
  }

  for (const campaign of campaignRecords) {
    const isEmail = campaignChannel.get(campaign.id) === 'email';
    const emailAt = campaignEmailAt.get(campaign.id);
    events.push({
      id: `campaign-${campaign.id}`,
      type: 'campaign',
      title: campaign.name,
      subtitle: isEmail
        ? campaignNames.get(campaign.id) ?? 'Email campaign'
        : campaignNames.get(campaign.id) ?? 'WhatsApp campaign',
      status: isEmail
        ? campaignEmailStatus.get(campaign.id) ?? 'Sent'
        : 'Sent',
      timestamp: (emailAt ?? campaign.sentAt ?? new Date()).toISOString(),
    });
  }

  events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return {
    contactId: contact.id,
    contactName: contact.name,
    contactPhone: contact.phone,
    summary: {
      journeys: journeyExecutions.length,
      bots: botSessions.length,
      aiReplies,
      campaigns: campaignIds.size,
      templates: templateSends,
    },
    events,
  };
}

function emailLogStatusLabel(status: string): string {
  switch (status.toLowerCase()) {
    case 'clicked':
      return 'Clicked';
    case 'opened':
      return 'Opened';
    case 'delivered':
      return 'Delivered';
    case 'sent':
      return 'Sent';
    case 'bounced':
      return 'Bounced';
    case 'failed':
      return 'Failed';
    case 'queued':
      return 'Queued';
    default:
      return status;
  }
}
