import type { Prisma, PrismaClient } from '@prisma/client';
import type { AnalyticsMetric, LogStatus } from '../types/journey.types.js';

export class JourneyExecutionRepository {
  constructor(private readonly db: PrismaClient) {}

  create(input: {
    journeyId: string;
    contactId: string;
    currentNodeId: string | null;
    status?: string;
    context?: Record<string, unknown>;
  }) {
    return this.db.journeyExecution.create({
      data: {
        journeyId: input.journeyId,
        contactId: input.contactId,
        currentNodeId: input.currentNodeId,
        status: input.status ?? 'running',
        context: (input.context ?? {}) as Prisma.InputJsonValue,
        lastExecutedAt: new Date(),
      },
    });
  }

  findById(id: string) {
    return this.db.journeyExecution.findUnique({
      where: { id },
      include: {
        journey: true,
        contact: true,
      },
    });
  }

  findActiveForContact(journeyId: string, contactId: string) {
    return this.db.journeyExecution.findFirst({
      where: {
        journeyId,
        contactId,
        status: { in: ['running', 'waiting'] },
      },
    });
  }

  updateProgress(
    id: string,
    data: {
      currentNodeId?: string | null;
      status?: string;
      context?: Record<string, unknown>;
      lastExecutedAt?: Date;
    }
  ) {
    return this.db.journeyExecution.update({
      where: { id },
      data: {
        ...(data.currentNodeId !== undefined ? { currentNodeId: data.currentNodeId } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.context !== undefined
          ? { context: data.context as Prisma.InputJsonValue }
          : {}),
        lastExecutedAt: data.lastExecutedAt ?? new Date(),
      },
    });
  }

  appendLog(input: {
    executionId: string;
    nodeId?: string | null;
    status: LogStatus;
    payload?: Record<string, unknown>;
  }) {
    return this.db.journeyExecutionLog.create({
      data: {
        executionId: input.executionId,
        nodeId: input.nodeId ?? null,
        status: input.status,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  logAnalytics(
    executionId: string,
    nodeId: string | null,
    metric: AnalyticsMetric,
    extra?: Record<string, unknown>
  ) {
    return this.appendLog({
      executionId,
      nodeId,
      status: 'success',
      payload: { metric, ...extra },
    });
  }

  getAnalytics(journeyId: string) {
    return this.db.journeyExecutionLog.findMany({
      where: {
        execution: { journeyId },
      },
      select: {
        payload: true,
        createdAt: true,
        nodeId: true,
      },
    });
  }

  countExecutionsByStatus(journeyId: string) {
    return this.db.journeyExecution.groupBy({
      by: ['status'],
      where: { journeyId },
      _count: { _all: true },
    });
  }

  findWaitingForReply(workspaceId: string, contactId: string) {
    return this.db.journeyExecution.findMany({
      where: {
        contactId,
        status: 'waiting',
        journey: { workspaceId },
      },
      include: { journey: true },
    });
  }

  findForContact(workspaceId: string, contactId: string, take = 5) {
    return this.db.journeyExecution.findMany({
      where: {
        contactId,
        journey: { workspaceId },
      },
      include: {
        journey: { select: { id: true, name: true, status: true } },
        logs: {
          orderBy: { createdAt: 'asc' },
          select: {
            nodeId: true,
            status: true,
            createdAt: true,
            payload: true,
          },
        },
      },
      orderBy: { startedAt: 'desc' },
      take,
    });
  }
}
