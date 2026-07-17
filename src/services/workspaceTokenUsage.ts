import { prisma } from '../index.js';

const INPUT_COST_PER_1K = 0.00015;
const OUTPUT_COST_PER_1K = 0.0006;
const USD_TO_INR = 85;

export type WorkspaceBillingMode = 'convosync' | 'byok';

export function calculateTokenCost(inputTokens: number, outputTokens: number) {
  const costUsd =
    (inputTokens / 1000) * INPUT_COST_PER_1K + (outputTokens / 1000) * OUTPUT_COST_PER_1K;
  const costInr = costUsd * USD_TO_INR;
  return { costUsd, costInr };
}

export async function resolveWorkspaceBillingMode(
  workspaceId: string
): Promise<WorkspaceBillingMode> {
  const row = await prisma.workspaceAiProviderConfig.findUnique({
    where: { workspaceId },
    select: { mode: true },
  });
  return row?.mode === 'byok' ? 'byok' : 'convosync';
}

export async function recordWorkspaceTokenUsage(params: {
  workspaceId: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  conversationId?: string | null;
  fromCache?: boolean;
  intentDetected?: string;
  skillsLoaded?: string[];
  kbChunksLoaded?: number;
  billingMode?: WorkspaceBillingMode;
  model?: string;
}) {
  const inputTokens = Math.max(0, Math.round(params.inputTokens));
  const outputTokens = Math.max(0, Math.round(params.outputTokens));
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) {
    const billingMode = params.billingMode ?? (await resolveWorkspaceBillingMode(params.workspaceId));
    return { costUsd: 0, costInr: 0, totalTokens: 0, billingMode };
  }

  const billingMode = params.billingMode ?? (await resolveWorkspaceBillingMode(params.workspaceId));
  const convoSyncBilled = billingMode !== 'byok';
  const { costUsd, costInr } = convoSyncBilled
    ? calculateTokenCost(inputTokens, outputTokens)
    : { costUsd: 0, costInr: 0 };

  const log = await prisma.tokenUsageLog.create({
    data: {
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: params.conversationId ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      costInr,
      model: params.model ?? 'gpt-4o-mini',
      fromCache: params.fromCache ?? false,
      intentDetected: params.intentDetected ?? null,
      skillsLoaded: params.skillsLoaded ?? [],
      kbChunksLoaded: params.kbChunksLoaded ?? 0,
    },
  });

  if (convoSyncBilled && costInr > 0) {
    const { chargeAiTokenUsage } = await import('./walletUsage.js');
    try {
      await chargeAiTokenUsage({
        workspaceId: params.workspaceId,
        costInr,
        referenceId: log.id,
        agentId: params.agentId,
      });
    } catch (err) {
      console.error('[wallet] AI debit failed', err);
    }
  }

  if (params.conversationId) {
    const agentConversation = await prisma.agentChatConversation.findUnique({
      where: { id: params.conversationId },
      select: { id: true },
    });
    if (agentConversation) {
      await prisma.agentChatConversation.update({
        where: { id: params.conversationId },
        data: {
          totalTokensUsed: { increment: totalTokens },
          totalCostInr: { increment: costInr },
          messageCount: { increment: 1 },
          lastMessageAt: new Date(),
        },
      });
    }
  }

  return { costUsd, costInr, totalTokens, billingMode };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Blended INR/1K tokens (70% input, 30% output) — matches plan included-credit estimates. */
export function avgTokenCostInrPer1k() {
  const inputInrPer1k = INPUT_COST_PER_1K * USD_TO_INR;
  const outputInrPer1k = OUTPUT_COST_PER_1K * USD_TO_INR;
  return inputInrPer1k * 0.7 + outputInrPer1k * 0.3;
}

export function computeTokenBillingCosts(params: {
  used: number;
  costInr: number;
  includedTokens: number;
}) {
  const { used, costInr, includedTokens } = params;
  // Wallet / pay-as-you-go: no included allotment → full cost is billed
  if (includedTokens <= 0) {
    return { costInr, includedCreditInr: 0, billedCostInr: round2(costInr) };
  }
  const includedCreditInr = round2(
    (Math.min(includedTokens, used) * avgTokenCostInrPer1k()) / 1000
  );
  const billedCostInr = round2(Math.max(0, costInr - includedCreditInr));
  return { costInr, includedCreditInr, billedCostInr };
}

export function getTokenRateInrPer1k() {
  return {
    input: INPUT_COST_PER_1K * USD_TO_INR,
    output: OUTPUT_COST_PER_1K * USD_TO_INR,
  };
}

export async function getWorkspaceTokenUsageBreakdown(
  workspaceId: string,
  start: Date,
  end: Date
) {
  const logs = await prisma.tokenUsageLog.findMany({
    where: {
      workspaceId,
      createdAt: { gte: start, lt: end },
      fromCache: false,
    },
    select: {
      agentId: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      costInr: true,
      createdAt: true,
    },
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let costInr = 0;
  const dailyTokenMap = new Map<number, number>();
  const agentTokenTotals = new Map<string, number>();

  for (const log of logs) {
    inputTokens += log.inputTokens;
    outputTokens += log.outputTokens;
    costInr += log.costInr;
    const day = log.createdAt.getDate();
    dailyTokenMap.set(day, (dailyTokenMap.get(day) ?? 0) + log.totalTokens);
    agentTokenTotals.set(log.agentId, (agentTokenTotals.get(log.agentId) ?? 0) + log.totalTokens);
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costInr: round2(costInr),
    dailyTokenMap,
    agentTokenTotals,
  };
}

export async function getWorkspaceMonthlyTokenUsage(workspaceId: string, reference = new Date()) {
  const monthStart = new Date(reference);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

  const usage = await prisma.tokenUsageLog.aggregate({
    where: {
      workspaceId,
      createdAt: { gte: monthStart, lt: monthEnd },
      fromCache: false,
    },
    _sum: {
      totalTokens: true,
      inputTokens: true,
      outputTokens: true,
      costInr: true,
    },
  });

  return {
    used: usage._sum.totalTokens ?? 0,
    inputTokens: usage._sum.inputTokens ?? 0,
    outputTokens: usage._sum.outputTokens ?? 0,
    costInr: usage._sum.costInr ?? 0,
  };
}
