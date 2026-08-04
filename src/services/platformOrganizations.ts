import { prisma } from '../index.js';
import { readCustomPlanInput } from './customPlanPricing.js';
import { countConnectedChannels } from './planUsageGuards.js';
import { planDisplayName } from './subscriptionPlans.js';
import { getWorkspaceUsageCost } from './usageCost.service.js';
import { getWorkspaceMonthlyTokenUsage } from './workspaceTokenUsage.js';
import { listWorkspaceMembersFormatted } from './workspaceMemberAdmin.js';
import {
  addDays,
  resolveTrialDays,
  subscriptionDisplayStatus,
  trialDaysLeft,
  type SubscriptionDisplayStatus,
} from './trial.js';

function resolveTrialWindow(workspace: {
  subscriptionStatus: string;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  createdAt: Date;
  plan: { trialDays: number } | null;
}) {
  const startedAt = workspace.trialStartedAt ?? workspace.createdAt;
  const endsAt =
    workspace.trialEndsAt ??
    addDays(startedAt, resolveTrialDays(workspace.plan));

  return { trialStartedAt: startedAt, trialEndsAt: endsAt };
}

function shortTenantId(workspaceId: string) {
  return `TN-${workspaceId.slice(-6).toUpperCase()}`;
}

function whatsappStatus(workspace: {
  waToken: string | null;
  waNumberId: string | null;
  waPhoneNumber: string | null;
}) {
  if (workspace.waToken && (workspace.waNumberId || workspace.waPhoneNumber)) {
    return 'Verified' as const;
  }
  if (workspace.waToken || workspace.waNumberId || workspace.waPhoneNumber) {
    return 'Pending' as const;
  }
  return 'Failed' as const;
}

function onboardingProgress(owner: {
  onboardingCompleted: boolean;
  onboardingStep: number;
} | null) {
  if (!owner) return 0;
  if (owner.onboardingCompleted) return 100;
  const step = Math.min(Math.max(owner.onboardingStep, 1), 7);
  return Math.round(((step - 1) / 6) * 100);
}

function deriveHealth(
  wa: 'Verified' | 'Pending' | 'Failed',
  onboardingCompleted: boolean
): 'Green' | 'Yellow' | 'Red' {
  if (wa === 'Verified' && onboardingCompleted) return 'Green';
  if (wa === 'Verified' || onboardingCompleted) return 'Yellow';
  return 'Red';
}

function workspacePlanLabel(workspace: { plan: { slug: string } | null }) {
  return workspace.plan ? planDisplayName(workspace.plan.slug) : 'No plan';
}

type CustomPlanPaymentStatus = 'none' | 'quoted' | 'pending' | 'paid' | 'failed';

type LatestCustomPlanInvoice = {
  status: string;
  amountPaise: number;
  currency: string;
  paidAt: Date | null;
};

function formatCustomPlanPayload(
  customPlanSelection: unknown,
  invoice: LatestCustomPlanInvoice | null | undefined
) {
  const saved = readCustomPlanInput(
    customPlanSelection as import('@prisma/client').Prisma.JsonValue
  );
  const record =
    customPlanSelection && typeof customPlanSelection === 'object' && !Array.isArray(customPlanSelection)
      ? (customPlanSelection as Record<string, unknown>)
      : null;

  if (!saved && !record?.monthlyTotal) {
    return {
      isCustomPlan: false,
      customPlan: null as null,
      customPlanPayment: null as null,
    };
  }

  const customPlan = {
    contacts: saved?.input.contacts ?? (record?.contacts as number) ?? 0,
    aiAgents: saved?.input.aiAgents ?? (record?.aiAgents as number) ?? 0,
    teamMembers: saved?.input.teamMembers ?? (record?.teamMembers as number) ?? 0,
    channels: saved?.input.channels ?? (record?.channels as number) ?? 0,
    emails: saved?.input.emails ?? (record?.emails as number) ?? 0,
    monthlyTotal:
      typeof record?.monthlyTotal === 'number' ? record.monthlyTotal : null,
    annualTotal: typeof record?.annualTotal === 'number' ? record.annualTotal : null,
    currency: typeof record?.currency === 'string' ? record.currency : 'USD',
    matchedPlanName:
      typeof record?.matchedPlanName === 'string' ? record.matchedPlanName : null,
    requiresSales: Boolean(record?.requiresSales),
    savedAt: saved?.savedAt ?? null,
    breakdown: Array.isArray(record?.breakdown) ? record.breakdown : [],
  };

  let paymentStatus: CustomPlanPaymentStatus = 'quoted';
  if (invoice) {
    if (invoice.status === 'paid') paymentStatus = 'paid';
    else if (invoice.status === 'created') paymentStatus = 'pending';
    else if (invoice.status === 'failed' || invoice.status === 'refunded') {
      paymentStatus = 'failed';
    } else {
      paymentStatus = 'pending';
    }
  }

  const customPlanPayment = {
    status: paymentStatus,
    amountPaise: invoice?.amountPaise ?? null,
    currency: invoice?.currency ?? customPlan.currency,
    paidAt: invoice?.paidAt?.toISOString() ?? null,
  };

  return {
    isCustomPlan: true,
    customPlan,
    customPlanPayment,
  };
}

async function loadLatestCustomPlanInvoices(workspaceIds: string[]) {
  if (workspaceIds.length === 0) {
    return new Map<string, LatestCustomPlanInvoice>();
  }

  const invoices = await prisma.billingInvoice.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      type: 'custom_plan',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      workspaceId: true,
      status: true,
      amountPaise: true,
      currency: true,
      paidAt: true,
    },
  });

  const map = new Map<string, LatestCustomPlanInvoice>();
  for (const invoice of invoices) {
    if (!map.has(invoice.workspaceId)) {
      map.set(invoice.workspaceId, invoice);
    }
  }
  return map;
}

export async function getPlatformOrganizationStats() {
  const [total, workspaces] = await Promise.all([
    prisma.workspace.count(),
    prisma.workspace.findMany({
      select: {
        waToken: true,
        waNumberId: true,
        waPhoneNumber: true,
      },
    }),
  ]);

  const verified = workspaces.filter(
    (w) => w.waToken && (w.waNumberId || w.waPhoneNumber)
  ).length;

  return {
    totalTenants: total,
    verified,
    systemHealthPercent: total === 0 ? 100 : Math.round((verified / total) * 100),
  };
}

const workspaceOrgInclude = {
  plan: true,
  memberships: {
    orderBy: { createdAt: 'asc' as const },
    include: { user: true },
  },
  _count: {
    select: {
      contacts: true,
      campaigns: true,
      memberships: true,
      conversations: true,
    },
  },
};

type WorkspaceOrgRow = Awaited<
  ReturnType<
    typeof prisma.workspace.findMany<{ include: typeof workspaceOrgInclude }>
  >
>[number];

function formatPlatformOrganization(
  workspace: WorkspaceOrgRow,
  latestCustomPlanInvoice?: LatestCustomPlanInvoice | null
) {
    const ownerMembership =
      workspace.memberships.find((m) => m.role === 'admin') ?? workspace.memberships[0];
    const owner = ownerMembership?.user ?? null;
    const members = workspace.memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      lastActive: m.user.createdAt.toISOString(),
    }));
    const wa = whatsappStatus(workspace);
    const onboardingCompleted = owner?.onboardingCompleted ?? false;
    const progress = onboardingProgress(owner);
    const health = deriveHealth(wa, onboardingCompleted);
    const trialWindow = resolveTrialWindow(workspace);
    const trialWorkspace = {
      subscriptionStatus: workspace.subscriptionStatus,
      trialStartedAt: trialWindow.trialStartedAt,
      trialEndsAt: trialWindow.trialEndsAt,
    };
    const status: SubscriptionDisplayStatus = subscriptionDisplayStatus(trialWorkspace);
    const daysLeft = trialDaysLeft(trialWorkspace);
    const customPlanFields = formatCustomPlanPayload(
      workspace.customPlanSelection,
      latestCustomPlanInvoice
    );
    const basePlan = workspacePlanLabel(workspace);
    const plan = customPlanFields.isCustomPlan ? 'Custom' : basePlan;
    const customMonthly = customPlanFields.customPlan?.monthlyTotal ?? 0;
    const customPaid = customPlanFields.customPlanPayment?.status === 'paid';
    const mrr =
      workspace.subscriptionStatus === 'trial'
        ? customPaid && customMonthly > 0
          ? customMonthly
          : 0
        : customPaid && customMonthly > 0
          ? customMonthly
          : workspace.plan?.priceMonthly ?? 0;

    return {
      id: workspace.id,
      tenantId: shortTenantId(workspace.id),
      name: workspace.name,
      slug: workspace.slug,
      legalName: workspace.legalName,
      email: workspace.email ?? owner?.email ?? '',
      phone: workspace.phone ?? owner?.phone ?? '',
      country: workspace.country ?? 'IN',
      industry: workspace.industry,
      accountType: workspace.accountType,
      plan,
      basePlan,
      planId: workspace.plan?.slug ?? null,
      isCustomPlan: customPlanFields.isCustomPlan,
      customPlan: customPlanFields.customPlan,
      customPlanPayment: customPlanFields.customPlanPayment,
      subscriptionStatus: workspace.subscriptionStatus,
      trialStartedAt: trialWindow.trialStartedAt.toISOString(),
      trialEndsAt: trialWindow.trialEndsAt.toISOString(),
      trialDaysLeft: daysLeft,
      mrr,
      whatsappStatus: wa,
      health,
      healthScore: health === 'Green' ? 92 : health === 'Yellow' ? 68 : 42,
      status,
      isTrial: status === 'Trial',
      ownerName: owner?.name ?? '—',
      ownerEmail: owner?.email ?? workspace.email ?? '',
      ownerPhone: owner?.phone ?? null,
      website: workspace.website,
      address: workspace.address,
      city: workspace.city,
      state: workspace.state,
      postalCode: workspace.postalCode,
      taxId: workspace.taxId,
      joinedDate: workspace.createdAt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      createdAt: workspace.createdAt.toISOString(),
      lastActive: workspace.updatedAt.toISOString(),
      whatsappNumber: workspace.waPhoneNumber ?? '—',
      bspProvider: workspace.waToken ? 'Meta Cloud API' : '—',
      onboardingProgress: progress,
      onboardingCompleted,
      onboardingStep: owner?.onboardingStep ?? 7,
      contacts: workspace._count.contacts,
      campaignsSent: workspace._count.campaigns,
      messagesThisMonth: workspace._count.conversations,
      memberCount: workspace._count.memberships,
      members,
      useCases: workspace.useCases,
      companySize: workspace.companySize,
      timezone: workspace.timezone,
    };
}

function hasPaidBillingRecord(billing: {
  subscriptionStatus: string | null;
  hasPaidInvoice: boolean;
}) {
  const paidStatuses = new Set(['active', 'authenticated', 'completed']);
  return billing.hasPaidInvoice || paidStatuses.has(billing.subscriptionStatus ?? '');
}

function mrrFromBillingDetail(billing: {
  billingCycle: string | null;
  planPriceMonthly: number | null;
  planPriceAnnual: number | null;
}) {
  if (billing.billingCycle === 'annual' && billing.planPriceAnnual != null) {
    return Math.round(billing.planPriceAnnual / 12);
  }
  return billing.planPriceMonthly ?? 0;
}

export async function getPlatformOrganizationById(id: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    include: workspaceOrgInclude,
  });
  if (!workspace) return null;
  const invoiceMap = await loadLatestCustomPlanInvoices([id]);
  const base = formatPlatformOrganization(workspace, invoiceMap.get(id));
  const [detail, operations] = await Promise.all([
    loadOrganizationDetail(workspace.id),
    loadWorkspaceOperations(workspace.id),
  ]);
  const paid = hasPaidBillingRecord(detail.billing);
  const billingMrr = mrrFromBillingDetail(detail.billing);
  const resolvedMrr = paid && billingMrr > 0 ? billingMrr : base.mrr;
  const usageSnapshot = await loadOrganizationCommercialSnapshot(workspace.id, {
    mrr: resolvedMrr,
    contacts: base.contacts,
    isTrial: paid ? false : base.isTrial,
    planName: base.plan,
    operationsStats: operations.stats,
  });

  return {
    ...base,
    ...detail,
    operations,
    usageCost: usageSnapshot.usageCost,
    commercial: usageSnapshot.commercial,
    mrr: resolvedMrr,
    isTrial: paid ? false : base.isTrial,
    status: paid && base.status === 'Trial' ? ('Active' as const) : base.status,
  };
}

async function loadWorkspaceOperations(workspaceId: string) {
  const [
    team,
    workspace,
    whatsappAccounts,
    instagramAccounts,
    messengerAccounts,
    googleConnections,
    templates,
    campaigns,
    journeys,
    agents,
    templateTotal,
    templatesApproved,
    campaignGroups,
    journeyGroups,
    channelsConnected,
    usageLimits,
  ] = await Promise.all([
    listWorkspaceMembersFormatted(workspaceId),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        waPhoneNumber: true,
        waNumberId: true,
        waToken: true,
        wabaId: true,
        fbPageName: true,
        emailIntegrationEnabled: true,
        createdAt: true,
      },
    }),
    prisma.whatsAppPhoneAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        phoneNumber: true,
        displayName: true,
        phoneNumberId: true,
        createdAt: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        pageName: true,
        createdAt: true,
      },
    }),
    prisma.messengerAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        pageName: true,
        displayName: true,
        pageId: true,
        createdAt: true,
      },
    }),
    prisma.googleConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        createdAt: true,
        productIntegrations: {
          select: { product: true, status: true },
        },
      },
    }),
    prisma.template.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        name: true,
        category: true,
        status: true,
        language: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        name: true,
        status: true,
        totalRecipients: true,
        sentCount: true,
        deliveredCount: true,
        readCount: true,
        scheduledAt: true,
        sentAt: true,
        createdAt: true,
      },
    }),
    prisma.journey.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.aiAgent.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        role: true,
        category: true,
        isEnabled: true,
        isPublished: true,
        conversationsCount: true,
        escalatedCount: true,
        flowsCount: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.template.count({ where: { workspaceId } }),
    prisma.template.count({ where: { workspaceId, status: 'approved' } }),
    prisma.campaign.groupBy({
      by: ['status'],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.journey.groupBy({
      by: ['status'],
      where: { workspaceId },
      _count: { _all: true },
    }),
    countConnectedChannels(workspaceId),
    prisma.workspaceUsageLimits.findUnique({
      where: { workspaceId },
      select: {
        channelsLimit: true,
        aiAgentsLimit: true,
        teamMembersLimit: true,
        contactsLimit: true,
        campaignsLimit: true,
      },
    }),
  ]);

  const channels: Array<{
    type: string;
    name: string;
    identifier: string;
    status: string;
    connectedAt: string;
  }> = [];

  const primaryWhatsAppListed = whatsappAccounts.some(
    (account) => account.phoneNumberId === workspace?.waNumberId
  );

  if (workspace?.waNumberId && workspace.waToken && !primaryWhatsAppListed) {
    channels.push({
      type: 'whatsapp',
      name: workspace.waPhoneNumber ?? 'Primary WhatsApp',
      identifier: workspace.waPhoneNumber ?? workspace.waNumberId,
      status: 'connected',
      connectedAt: workspace.createdAt.toISOString(),
    });
  }

  for (const account of whatsappAccounts) {
    channels.push({
      type: 'whatsapp',
      name: account.displayName ?? account.phoneNumber ?? 'WhatsApp',
      identifier: account.phoneNumber ?? account.phoneNumberId,
      status: 'connected',
      connectedAt: account.createdAt.toISOString(),
    });
  }

  for (const account of instagramAccounts) {
    channels.push({
      type: 'instagram',
      name: account.displayName ?? account.pageName ?? account.username ?? 'Instagram',
      identifier: account.username ? `@${account.username}` : account.id,
      status: 'connected',
      connectedAt: account.createdAt.toISOString(),
    });
  }

  for (const account of messengerAccounts) {
    channels.push({
      type: 'messenger',
      name: account.displayName ?? account.pageName ?? 'Messenger',
      identifier: account.pageId,
      status: 'connected',
      connectedAt: account.createdAt.toISOString(),
    });
  }

  if (workspace?.emailIntegrationEnabled) {
    channels.push({
      type: 'email',
      name: 'Email',
      identifier: 'workspace-email',
      status: 'connected',
      connectedAt: workspace.createdAt.toISOString(),
    });
  }

  for (const connection of googleConnections) {
    const connectedProducts = connection.productIntegrations
      .filter((p) => p.status === 'connected')
      .map((p) => p.product.replace(/_/g, ' '));
    channels.push({
      type: 'google',
      name: connection.displayName ?? connection.email,
      identifier: connection.email,
      status: connection.status,
      connectedAt: connection.createdAt.toISOString(),
    });
    if (connectedProducts.length > 0) {
      channels[channels.length - 1].name = `${channels[channels.length - 1].name} (${connectedProducts.join(', ')})`;
    }
  }

  const campaignStatusCounts = Object.fromEntries(
    campaignGroups.map((row) => [row.status, row._count._all])
  );
  const journeyStatusCounts = Object.fromEntries(
    journeyGroups.map((row) => [row.status, row._count._all])
  );
  const campaignsRun =
    (campaignStatusCounts.sent ?? 0) +
    (campaignStatusCounts.completed ?? 0) +
    (campaignStatusCounts.running ?? 0);

  return {
    stats: {
      teamMembers: team.length,
      teamMembersLimit: usageLimits?.teamMembersLimit ?? null,
      channelsConnected,
      channelsLimit: usageLimits?.channelsLimit ?? null,
      templatesTotal: templateTotal,
      templatesApproved,
      campaignsTotal: Object.values(campaignStatusCounts).reduce((sum, n) => sum + n, 0),
      campaignsRun,
      journeysTotal: Object.values(journeyStatusCounts).reduce((sum, n) => sum + n, 0),
      journeysPublished: journeyStatusCounts.published ?? 0,
      agentsTotal: agents.length,
      agentsPublished: agents.filter((a) => a.isPublished).length,
      agentsEnabled: agents.filter((a) => a.isEnabled).length,
      agentsLimit: usageLimits?.aiAgentsLimit ?? null,
      contactsLimit: usageLimits?.contactsLimit ?? null,
      campaignsLimit: usageLimits?.campaignsLimit ?? null,
    },
    team: team.map((member) => ({
      id: member.id,
      userId: member.userId,
      name: member.name,
      email: member.email,
      role: member.role,
      permissions: member.permissions,
      inboxScope: member.inboxScope,
      isOwner: member.isOwner,
      joinedAt: member.joinedAt.toISOString(),
    })),
    channels,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      status: t.status,
      language: t.language,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      totalRecipients: c.totalRecipients,
      sentCount: c.sentCount,
      deliveredCount: c.deliveredCount,
      readCount: c.readCount,
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      sentAt: c.sentAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    journeys: journeys.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      category: a.category,
      isEnabled: a.isEnabled,
      isPublished: a.isPublished,
      conversationsCount: a.conversationsCount,
      escalatedCount: a.escalatedCount,
      flowsCount: a.flowsCount,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  };
}

async function loadOrganizationDetail(workspaceId: string) {
  const [workspace, invoices, usageLimits, tokenUsage, trialLogs, billingSubscription, recentCampaigns] =
    await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          subscriptionStatus: true,
          customPlanSelection: true,
          plan: {
            select: {
              slug: true,
              name: true,
              priceMonthly: true,
              priceAnnual: true,
            },
          },
        },
      }),
      prisma.billingInvoice.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          type: true,
          status: true,
          amountPaise: true,
          currency: true,
          description: true,
          createdAt: true,
          paidAt: true,
        },
      }),
      prisma.workspaceUsageLimits.findUnique({ where: { workspaceId } }),
      getWorkspaceMonthlyTokenUsage(workspaceId),
      prisma.trialExtensionLog.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { platformAdmin: { select: { name: true } } },
      }),
      prisma.billingSubscription.findFirst({
        where: {
          workspaceId,
          status: { in: ['active', 'authenticated', 'created', 'paused', 'completed'] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          status: true,
          billingCycle: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          cancelledAt: true,
          razorpaySubscriptionId: true,
          plan: {
            select: { name: true, slug: true, priceMonthly: true, priceAnnual: true },
          },
        },
      }),
      prisma.campaign.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, name: true, status: true, createdAt: true },
      }),
    ]);

  const activities: Array<{ text: string; time: string; color: string }> = [];

  for (const log of trialLogs) {
    activities.push({
      text: `Trial extended by ${log.daysAdded} days${log.platformAdmin ? ` by ${log.platformAdmin.name}` : ''}`,
      time: log.createdAt.toISOString(),
      color: '#0EA5E9',
    });
  }

  for (const invoice of invoices.slice(0, 5)) {
    activities.push({
      text: `Invoice ${invoice.status} — ${(invoice.amountPaise / 100).toFixed(2)} ${invoice.currency}`,
      time: (invoice.paidAt ?? invoice.createdAt).toISOString(),
      color: invoice.status === 'paid' ? '#10B981' : '#F59E0B',
    });
  }

  for (const campaign of recentCampaigns) {
    activities.push({
      text: `Campaign "${campaign.name}" — ${campaign.status}`,
      time: campaign.createdAt.toISOString(),
      color: '#8B5CF6',
    });
  }

  activities.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return {
    billing: {
      subscriptionStatus:
        billingSubscription?.status ?? workspace?.subscriptionStatus ?? null,
      billingCycle: billingSubscription?.billingCycle ?? null,
      currentPeriodStart: billingSubscription?.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: billingSubscription?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: billingSubscription?.cancelAtPeriodEnd ?? false,
      cancelledAt: billingSubscription?.cancelledAt?.toISOString() ?? null,
      razorpaySubscriptionId: billingSubscription?.razorpaySubscriptionId ?? null,
      subscribedPlanName: billingSubscription?.plan?.name ?? workspace?.plan?.name ?? null,
      subscribedPlanSlug: billingSubscription?.plan?.slug ?? workspace?.plan?.slug ?? null,
      planPriceMonthly:
        billingSubscription?.plan?.priceMonthly ?? workspace?.plan?.priceMonthly ?? null,
      planPriceAnnual:
        billingSubscription?.plan?.priceAnnual ?? workspace?.plan?.priceAnnual ?? null,
      planCurrency: 'INR',
      hasPaidInvoice: invoices.some((inv) => inv.status === 'paid'),
      invoices: invoices.map((inv) => ({
        id: inv.id,
        type: inv.type,
        status: inv.status,
        description: inv.description,
        amount: `₹${(inv.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        amountPaise: inv.amountPaise,
        currency: inv.currency,
        date: inv.createdAt.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        paidAt: inv.paidAt?.toISOString() ?? null,
      })),
    },
    usage: {
      aiTokensUsed: tokenUsage.used,
      aiTokensCostInr: tokenUsage.costInr,
      contactsLimit: usageLimits?.contactsLimit ?? null,
      channelsLimit: usageLimits?.channelsLimit ?? null,
      aiTokensIncluded: usageLimits?.aiTokensIncluded ?? null,
    },
    activities: activities.slice(0, 12),
  };
}

export async function getPlatformOrganizationUsageCost(workspaceId: string, month?: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      subscriptionStatus: true,
      customPlanSelection: true,
      plan: { select: { name: true, priceMonthly: true, priceAnnual: true } },
      _count: { select: { contacts: true } },
    },
  });
  if (!workspace) return null;

  const [usageCost, operations, billingSubscription] = await Promise.all([
    getWorkspaceUsageCost(workspaceId, month),
    loadWorkspaceOperations(workspaceId),
    prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        status: { in: ['active', 'authenticated', 'completed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        billingCycle: true,
        plan: { select: { priceMonthly: true, priceAnnual: true, name: true } },
      },
    }),
  ]);

  const customPlanRaw = workspace.customPlanSelection;
  const customMonthly =
    customPlanRaw &&
    typeof customPlanRaw === 'object' &&
    !Array.isArray(customPlanRaw) &&
    typeof (customPlanRaw as Record<string, unknown>).monthlyTotal === 'number'
      ? ((customPlanRaw as Record<string, unknown>).monthlyTotal as number)
      : 0;
  let mrr = workspace.plan?.priceMonthly ?? 0;
  if (billingSubscription?.billingCycle === 'annual' && billingSubscription.plan?.priceAnnual) {
    mrr = Math.round(billingSubscription.plan.priceAnnual / 12);
  } else if (billingSubscription?.plan?.priceMonthly) {
    mrr = billingSubscription.plan.priceMonthly;
  } else if (customMonthly > 0) {
    mrr = customMonthly;
  }

  const isTrial = workspace.subscriptionStatus === 'trial';
  const commercial = buildCommercialInsights({
    mrr,
    contacts: workspace._count.contacts,
    isTrial,
    planName: billingSubscription?.plan?.name ?? workspace.plan?.name ?? 'No plan',
    operationsStats: operations.stats,
    usageCost,
  });

  return { usageCost, commercial };
}

function utilizationPct(used: number, limit: number | null | undefined): number | null {
  if (limit == null || limit <= 0 || limit >= 999_999) return null;
  return Math.min(999, Math.round((used / limit) * 100));
}

function buildCommercialInsights(input: {
  mrr: number;
  contacts: number;
  isTrial: boolean;
  planName: string;
  operationsStats: Awaited<ReturnType<typeof loadWorkspaceOperations>>['stats'];
  usageCost: Awaited<ReturnType<typeof getWorkspaceUsageCost>>;
}) {
  const { mrr, contacts, isTrial, planName, operationsStats, usageCost } = input;
  const usageCostInr = usageCost.summary.totalCostInr;
  const estimatedMarginInr = mrr > 0 ? Math.round((mrr - usageCostInr) * 100) / 100 : null;
  const marginPct =
    mrr > 0 && estimatedMarginInr != null
      ? Math.round((estimatedMarginInr / mrr) * 100)
      : null;

  const utilization = {
    contacts: {
      used: contacts,
      limit: operationsStats.contactsLimit,
      pct: utilizationPct(contacts, operationsStats.contactsLimit),
    },
    channels: {
      used: operationsStats.channelsConnected,
      limit: operationsStats.channelsLimit,
      pct: utilizationPct(operationsStats.channelsConnected, operationsStats.channelsLimit),
    },
    agents: {
      used: operationsStats.agentsTotal,
      limit: operationsStats.agentsLimit,
      pct: utilizationPct(operationsStats.agentsTotal, operationsStats.agentsLimit),
    },
    teamMembers: {
      used: operationsStats.teamMembers,
      limit: operationsStats.teamMembersLimit,
      pct: utilizationPct(operationsStats.teamMembers, operationsStats.teamMembersLimit),
    },
    aiTokens: {
      used: usageCost.ai.grossCostInr,
      included: usageCost.ai.includedTokens,
      pct: usageCost.ai.includedTokens > 0 ? usageCost.ai.quotaPct : null,
    },
    emails: {
      sent: usageCost.summary.emailsSent,
      included: usageCost.email.included,
      pct: utilizationPct(usageCost.summary.emailsSent, usageCost.email.included),
    },
    campaigns: {
      used: operationsStats.campaignsTotal,
      limit: operationsStats.campaignsLimit,
      pct: utilizationPct(operationsStats.campaignsTotal, operationsStats.campaignsLimit),
    },
  };

  const offerSignals: Array<{
    priority: 'high' | 'medium' | 'low';
    type: string;
    title: string;
    reason: string;
    suggestion: string;
  }> = [];

  if (utilization.contacts.pct != null && utilization.contacts.pct >= 80) {
    offerSignals.push({
      priority: utilization.contacts.pct >= 95 ? 'high' : 'medium',
      type: 'contacts',
      title: 'Contact limit approaching',
      reason: `${contacts.toLocaleString('en-IN')} contacts vs ${operationsStats.contactsLimit} limit`,
      suggestion: 'Offer contact pack add-on or plan upgrade',
    });
  }

  if (utilization.aiTokens.pct != null && utilization.aiTokens.pct >= 85) {
    offerSignals.push({
      priority: utilization.aiTokens.pct >= 95 ? 'high' : 'medium',
      type: 'ai_tokens',
      title: 'AI usage near limit',
      reason: `${utilization.aiTokens.pct}% of included AI tokens used this month`,
      suggestion: 'Offer AI token add-on or upgrade to a higher plan',
    });
  }

  if (utilization.channels.pct != null && utilization.channels.pct >= 80) {
    offerSignals.push({
      priority: utilization.channels.pct >= 100 ? 'high' : 'medium',
      type: 'channels',
      title: 'Channel limit pressure',
      reason: `${operationsStats.channelsConnected} of ${operationsStats.channelsLimit} channels in use`,
      suggestion: 'Offer channel add-on or Pro plan with more integrations',
    });
  }

  if (utilization.agents.pct != null && utilization.agents.pct >= 80) {
    offerSignals.push({
      priority: utilization.agents.pct >= 100 ? 'high' : 'medium',
      type: 'ai_agents',
      title: 'AI agent capacity',
      reason: `${operationsStats.agentsTotal} of ${operationsStats.agentsLimit} AI agents created`,
      suggestion: 'Pitch additional AI agent seats or enterprise bundle',
    });
  }

  if (utilization.emails.pct != null && utilization.emails.pct >= 80) {
    offerSignals.push({
      priority: utilization.emails.pct >= 95 ? 'high' : 'medium',
      type: 'email',
      title: 'Email volume high',
      reason: `${usageCost.summary.emailsSent} emails sent vs ${usageCost.email.included} included`,
      suggestion: 'Offer email volume pack or annual plan discount',
    });
  }

  if (isTrial && usageCostInr >= 500) {
    offerSignals.push({
      priority: 'high',
      type: 'trial_conversion',
      title: 'High-value trial',
      reason: `₹${usageCostInr.toLocaleString('en-IN')} platform cost this month on trial`,
      suggestion: 'Send paid plan offer with limited-time discount',
    });
  }

  if (isTrial && operationsStats.campaignsRun > 0) {
    offerSignals.push({
      priority: 'medium',
      type: 'trial_engagement',
      title: 'Active trial — campaigns running',
      reason: `${operationsStats.campaignsRun} campaign(s) already executed`,
      suggestion: 'Offer Starter/Growth plan before trial ends',
    });
  }

  if (mrr > 0 && usageCostInr > mrr * 0.55) {
    offerSignals.push({
      priority: 'high',
      type: 'margin_risk',
      title: 'Usage cost vs revenue',
      reason: `Monthly usage ₹${usageCostInr.toLocaleString('en-IN')} vs MRR ₹${mrr.toLocaleString('en-IN')}`,
      suggestion: 'Review plan pricing, usage caps, or upsell to higher tier',
    });
  }

  if (usageCost.summary.costChangePct >= 25) {
    offerSignals.push({
      priority: 'medium',
      type: 'usage_spike',
      title: 'Usage spike vs last month',
      reason: `Cost up ${usageCost.summary.costChangePct}% month over month`,
      suggestion: 'Proactive check-in — offer optimization or upgraded bundle',
    });
  }

  if (operationsStats.templatesTotal >= 5 && operationsStats.campaignsRun === 0) {
    offerSignals.push({
      priority: 'low',
      type: 'activation',
      title: 'Templates ready, no campaigns',
      reason: `${operationsStats.templatesTotal} templates but no campaigns sent yet`,
      suggestion: 'Offer campaign setup help or onboarding call',
    });
  }

  return {
    planName,
    isTrial,
    mrrInr: mrr,
    usageCostInr,
    estimatedMarginInr,
    marginPct,
    utilization,
    offerSignals: offerSignals.slice(0, 8),
  };
}

async function loadOrganizationCommercialSnapshot(
  workspaceId: string,
  input: {
    mrr: number;
    contacts: number;
    isTrial: boolean;
    planName: string;
    operationsStats: Awaited<ReturnType<typeof loadWorkspaceOperations>>['stats'];
  }
) {
  const usageCost = await getWorkspaceUsageCost(workspaceId);
  const commercial = buildCommercialInsights({
    mrr: input.mrr,
    contacts: input.contacts,
    isTrial: input.isTrial,
    planName: input.planName,
    operationsStats: input.operationsStats,
    usageCost,
  });
  return { usageCost, commercial };
}

export async function listPlatformOrganizations(options: {
  page: number;
  pageSize: number;
  search?: string;
}) {
  const { page, pageSize, search } = options;
  const q = search?.trim();

  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { slug: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
          { legalName: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [total, workspaces] = await Promise.all([
    prisma.workspace.count({ where }),
    prisma.workspace.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: workspaceOrgInclude,
    }),
  ]);

  const invoiceMap = await loadLatestCustomPlanInvoices(workspaces.map((w) => w.id));

  const organizations = workspaces.map((workspace) =>
    formatPlatformOrganization(workspace, invoiceMap.get(workspace.id))
  );

  return {
    organizations,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}
