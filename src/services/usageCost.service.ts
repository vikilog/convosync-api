import { prisma } from '../index.js';
import {
  AI_USAGE_MARKUP_MULTIPLIER,
  applyAiUsageMarkup,
  EMAIL_RATE_INR_PER_SEND,
  WA_CONVERSATION_RATES_INR,
  WA_SERVICE_FREE_CONVERSATIONS,
  WA_SERVICE_OVERAGE_RATE_INR,
  WHATSAPP_CATEGORY_META,
  type WhatsAppConversationCategory,
} from './usageCost.constants.js';
import {
  allocateAiLineCosts,
  getWorkspaceTokenUsageBreakdown,
  resolveWorkspaceBillingMode,
} from './workspaceTokenUsage.js';
import { getWalletSummary } from './wallet.service.js';

export type UsageMonthRange = {
  start: Date;
  end: Date;
  month: string;
};

export function parseUsageMonth(month?: string): UsageMonthRange {
  const now = new Date();
  let year = now.getFullYear();
  let monthIndex = now.getMonth();

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    if (y >= 2020 && m >= 1 && m <= 12) {
      year = y;
      monthIndex = m - 1;
    }
  }

  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  return { start, end, month: monthKey };
}

function normalizeTemplateCategory(raw: string | null | undefined): WhatsAppConversationCategory {
  const key = (raw ?? '').trim().toUpperCase();
  if (key === 'MARKETING') return 'marketing';
  if (key === 'UTILITY') return 'utility';
  if (key === 'AUTHENTICATION') return 'authentication';
  return 'service';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function agentDisplayName(agentId: string, agentNameById: Map<string, string>): string {
  if (agentId === 'ai_copilot') return 'AI Copilot';
  if (agentId === 'ai_knowledge') return 'AI Knowledge';
  return agentNameById.get(agentId) ?? 'Unknown agent';
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function conversationDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeServiceBilledCost(conversations: number): number {
  if (conversations <= WA_SERVICE_FREE_CONVERSATIONS) return 0;
  return round2((conversations - WA_SERVICE_FREE_CONVERSATIONS) * WA_SERVICE_OVERAGE_RATE_INR);
}

function computeWhatsAppRowCost(category: WhatsAppConversationCategory, conversations: number): number {
  if (category === 'service') return computeServiceBilledCost(conversations);
  return round2(conversations * WA_CONVERSATION_RATES_INR[category]);
}

export async function getWorkspaceUsageCost(
  workspaceId: string,
  month?: string,
  options?: { includeComparison?: boolean }
) {
  const includeComparison = options?.includeComparison !== false;
  const range = parseUsageMonth(month);
  const prevRange = parseUsageMonth(shiftMonth(range.month, -1));

  const [whatsappMessages, emailCount, templates, aiAgents, tokenBreakdown, billingMode, wallet] =
    await Promise.all([
    prisma.message.findMany({
      where: {
        sender: 'agent',
        createdAt: { gte: range.start, lt: range.end },
        conversation: { workspaceId, channel: 'whatsapp' },
      },
      select: {
        id: true,
        content: true,
        type: true,
        createdAt: true,
        metadata: true,
        conversation: {
          select: {
            contactId: true,
            assigneeType: true,
            assigneeId: true,
          },
        },
      },
    }),
    prisma.emailLog.count({
      where: {
        workspaceId,
        createdAt: { gte: range.start, lt: range.end },
        status: { in: ['sent', 'delivered', 'opened', 'clicked'] },
      },
    }),
    prisma.template.findMany({
      where: { workspaceId },
      select: { id: true, category: true },
    }),
    prisma.aiAgent.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    }),
    getWorkspaceTokenUsageBreakdown(workspaceId, range.start, range.end),
    resolveWorkspaceBillingMode(workspaceId),
    getWalletSummary(workspaceId),
  ]);

  const templateCategoryById = new Map(templates.map((t) => [t.id, normalizeTemplateCategory(t.category)]));
  const agentNameById = new Map(aiAgents.map((a) => [a.id, a.name]));

  const conversationKeys = new Set<string>();
  const categoryConversationCounts: Record<WhatsAppConversationCategory, number> = {
    marketing: 0,
    utility: 0,
    authentication: 0,
    service: 0,
  };

  let aiInputTokens = 0;
  let aiOutputTokens = 0;
  const agentTokenTotals = new Map<string, number>();

  for (const msg of whatsappMessages) {
    const meta = readMetadata(msg.metadata);
    let category: WhatsAppConversationCategory = 'service';

    const templateId =
      (typeof meta.templateId === 'string' && meta.templateId) ||
      (msg.type === 'template' && typeof meta.templateId === 'string' ? meta.templateId : null);

    if (templateId && templateCategoryById.has(templateId)) {
      category = templateCategoryById.get(templateId)!;
    } else if (msg.type === 'template') {
      category = 'marketing';
    }

    const day = conversationDayKey(msg.createdAt);
    const convKey = `${msg.conversation.contactId}:${category}:${day}`;
    if (!conversationKeys.has(convKey)) {
      conversationKeys.add(convKey);
      categoryConversationCounts[category] += 1;
    }
  }

  aiInputTokens = tokenBreakdown.inputTokens;
  aiOutputTokens = tokenBreakdown.outputTokens;
  for (const [agentId, tokens] of tokenBreakdown.agentTokenTotals.entries()) {
    agentTokenTotals.set(agentId, tokens);
  }

  const whatsappRows = (Object.keys(WHATSAPP_CATEGORY_META) as WhatsAppConversationCategory[]).map(
    (key) => {
      const conversations = categoryConversationCounts[key];
      const rateInr = WA_CONVERSATION_RATES_INR[key];
      const grossCost = round2(conversations * rateInr);
      const billedCost = computeWhatsAppRowCost(key, conversations);
      const meta = WHATSAPP_CATEGORY_META[key];
      const rateLabel =
        key === 'service'
          ? conversations > WA_SERVICE_FREE_CONVERSATIONS
            ? `₹${WA_SERVICE_OVERAGE_RATE_INR.toFixed(2)}/conv`
            : '₹0.00/conv'
          : `₹${rateInr.toFixed(2)}/conv`;

      return {
        key,
        label: meta.label,
        dot: meta.dot,
        badge: meta.badge,
        chartColor: meta.chartColor,
        conversations,
        rate: rateLabel,
        grossCost,
        billedCost,
      };
    }
  );

  const whatsappMessagesSent = whatsappMessages.length;
  const whatsappGrossCost = round2(whatsappRows.reduce((s, r) => s + r.grossCost, 0));
  const whatsappBilledTotal = round2(whatsappRows.reduce((s, r) => s + r.billedCost, 0));

  const aiTotalTokens = aiInputTokens + aiOutputTokens;
  const aiRawCostInr = round2(tokenBreakdown.costInr);
  const lineCosts = allocateAiLineCosts({
    inputTokens: aiInputTokens,
    outputTokens: aiOutputTokens,
    rawCostInr: aiRawCostInr,
  });
  const aiGrossCostInr = round2(applyAiUsageMarkup(aiRawCostInr));
  // No free included credit — wallet pays full marked-up AI cost.
  const aiBilledCostInr = aiGrossCostInr;

  // 1 CC = 1 email — every send bills the wallet (nothing free on plan).
  const emailGrossCostInr = round2(emailCount * EMAIL_RATE_INR_PER_SEND);
  const emailBilledCostInr = emailGrossCostInr;

  const totalCostInr = round2(whatsappBilledTotal + aiBilledCostInr + emailBilledCostInr);

  const daysInMonth = new Date(range.start.getFullYear(), range.start.getMonth() + 1, 0).getDate();
  const dailyTokens = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    tokens: tokenBreakdown.dailyTokenMap.get(i + 1) ?? 0,
  }));

  const agentUsage = [...agentTokenTotals.entries()]
    .map(([agentId, tokens]) => ({
      agentId,
      name: agentDisplayName(agentId, agentNameById),
      tokens,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const agentTotalTokens = agentUsage.reduce((s, a) => s + a.tokens, 0) || 1;
  const agentsWithPct = agentUsage.map((a) => ({
    ...a,
    pct: Math.round((a.tokens / agentTotalTokens) * 100),
  }));

  const prevTotal = includeComparison
    ? (await getWorkspaceUsageCost(workspaceId, prevRange.month, { includeComparison: false }))
        .summary.totalCostInr
    : 0;

  const costChangePct =
    includeComparison && prevTotal > 0
      ? round2(((totalCostInr - prevTotal) / prevTotal) * 100)
      : includeComparison && totalCostInr > 0
        ? 100
        : 0;

  return {
    month: range.month,
    summary: {
      totalCostInr,
      costChangePct,
      whatsappMessagesSent,
      whatsappCostInr: whatsappBilledTotal,
      aiTokensUsed: aiTotalTokens,
      aiCostInr: aiBilledCostInr,
      emailsSent: emailCount,
      emailCostInr: emailBilledCostInr,
    },
    // Main token balance — WA + AI + email Final billed amounts debit this wallet
    wallet: {
      balanceInr: wallet.balanceInr,
      monthSpentInr: wallet.monthSpentInr,
      isLowBalance: wallet.isLowBalance,
    },
    whatsapp: {
      rows: whatsappRows,
      grossCostInr: whatsappGrossCost,
      billedCostInr: whatsappBilledTotal,
      totalConversations: [...conversationKeys].length,
    },
    ai: {
      billingMode,
      inputTokens: aiInputTokens,
      outputTokens: aiOutputTokens,
      totalTokens: aiTotalTokens,
      inputRateInrPer1k: lineCosts.inputRateInrPer1k,
      outputRateInrPer1k: lineCosts.outputRateInrPer1k,
      inputCostInr: lineCosts.inputCostInr,
      outputCostInr: lineCosts.outputCostInr,
      rawCostInr: aiRawCostInr,
      markupMultiplier: AI_USAGE_MARKUP_MULTIPLIER,
      markupInr: round2(Math.max(0, aiGrossCostInr - aiRawCostInr)),
      grossCostInr: aiGrossCostInr,
      includedTokens: 0,
      includedCreditInr: 0,
      billedCostInr: aiBilledCostInr,
      dailyTokens,
      agents: agentsWithPct,
      quotaPct: 0,
    },
    email: {
      sent: emailCount,
      included: 0,
      unlimited: false,
      rateInrPerSend: EMAIL_RATE_INR_PER_SEND,
      grossCostInr: emailGrossCostInr,
      includedCreditInr: 0,
      billedCostInr: emailBilledCostInr,
      quotaPct: 0,
    },
  };
}

function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
