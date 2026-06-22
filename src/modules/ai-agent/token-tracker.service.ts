import { FastifyInstance } from 'fastify';
import {
  calculateTokenCost,
  getWorkspaceMonthlyTokenUsage,
  recordWorkspaceTokenUsage,
  resolveWorkspaceBillingMode,
} from '../../services/workspaceTokenUsage.js';

export class TokenTrackerService {
  constructor(private fastify: FastifyInstance) {}

  get prisma() {
    return this.fastify.prisma;
  }

  calculateCost(inputTokens: number, outputTokens: number) {
    return calculateTokenCost(inputTokens, outputTokens);
  }

  async logUsage(params: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    inputTokens: number;
    outputTokens: number;
    fromCache: boolean;
    intentDetected: string;
    skillsLoaded: string[];
    kbChunksLoaded: number;
    billingMode?: 'convosync' | 'byok';
  }) {
    const result = await recordWorkspaceTokenUsage({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: params.conversationId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      fromCache: params.fromCache,
      intentDetected: params.intentDetected,
      skillsLoaded: params.skillsLoaded,
      kbChunksLoaded: params.kbChunksLoaded,
      billingMode: params.billingMode,
    });

    const billingMode = params.billingMode ?? (await resolveWorkspaceBillingMode(params.workspaceId));
    if (billingMode !== 'byok') {
      await this.checkAndEnforceQuota(params.workspaceId);
    }

    return {
      costUsd: result.costUsd,
      costInr: result.costInr,
      totalTokens: result.totalTokens,
    };
  }

  async checkAndEnforceQuota(workspaceId: string): Promise<{
    exceeded: boolean;
    used: number;
    limit: number;
    overageTokens: number;
  }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { isSuperAdmin: true },
    });
    if (workspace?.isSuperAdmin) {
      return {
        exceeded: false,
        used: 0,
        limit: 0,
        overageTokens: 0,
      };
    }

    const providerRow = await this.prisma.workspaceAiProviderConfig.findUnique({
      where: { workspaceId },
    });
    if (providerRow?.mode === 'byok') {
      return {
        exceeded: false,
        used: 0,
        limit: 0,
        overageTokens: 0,
      };
    }

    const month = new Date().toISOString().substring(0, 7);
    const monthStart = new Date(`${month}-01`);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const monthlyUsage = await getWorkspaceMonthlyTokenUsage(workspaceId);
    const usedTokens = monthlyUsage.used;

    const limits = await this.prisma.workspaceUsageLimits.findUnique({
      where: { workspaceId },
    });

    // 0 or missing = unlimited (matches billing backfill for unlimited/custom plans)
    const rawLimit = limits?.aiTokensIncluded;
    if (rawLimit == null || rawLimit <= 0) {
      return {
        exceeded: false,
        used: usedTokens,
        limit: 0,
        overageTokens: 0,
      };
    }

    const planLimit = rawLimit;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const dailyUsage = await this.prisma.tokenUsageLog.aggregate({
      where: {
        workspaceId,
        createdAt: { gte: today, lt: todayEnd },
        fromCache: false,
      },
      _sum: { totalTokens: true },
    });

    const dailyTokensUsed = dailyUsage._sum.totalTokens || 0;
    // ~5x fair daily share, minimum 500 tokens/day so preview testing works on small plans
    const dailyLimit = Math.max(Math.ceil(planLimit / 30) * 5, 500);

    const monthlyExceeded = usedTokens > planLimit;
    const dailyExceeded = dailyTokensUsed > dailyLimit;

    return {
      exceeded: monthlyExceeded || dailyExceeded,
      used: usedTokens,
      limit: planLimit,
      overageTokens: Math.max(0, usedTokens - planLimit),
    };
  }
}
