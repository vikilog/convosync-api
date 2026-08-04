import type { Prisma, PrismaClient } from '@prisma/client';
import type { LogStatus } from '../types/ig-journey.types.js';

export class InstagramJourneyExecutionRepository {
  constructor(private readonly db: PrismaClient) {}

  create(input: {
    journeyId: string;
    contactId: string;
    currentNodeId: string | null;
    status?: string;
    context?: Record<string, unknown>;
  }) {
    return this.db.instagramJourneyExecution.create({
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
    return this.db.instagramJourneyExecution.findUnique({
      where: { id },
      include: { journey: true, contact: true },
    });
  }

  findActiveForContact(journeyId: string, contactId: string) {
    return this.db.instagramJourneyExecution.findFirst({
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
    }
  ) {
    return this.db.instagramJourneyExecution.update({
      where: { id },
      data: {
        ...(data.currentNodeId !== undefined ? { currentNodeId: data.currentNodeId } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.context !== undefined
          ? { context: data.context as Prisma.InputJsonValue }
          : {}),
        lastExecutedAt: new Date(),
      },
    });
  }

  appendLog(input: {
    executionId: string;
    nodeId?: string | null;
    status: LogStatus;
    payload?: Record<string, unknown>;
  }) {
    return this.db.instagramJourneyExecutionLog.create({
      data: {
        executionId: input.executionId,
        nodeId: input.nodeId ?? null,
        status: input.status,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  findWaitingForReply(workspaceId: string, contactId: string) {
    return this.db.instagramJourneyExecution.findMany({
      where: {
        contactId,
        status: 'waiting',
        journey: { workspaceId },
      },
      include: { journey: true },
    });
  }

  findForContact(workspaceId: string, contactId: string, take = 5) {
    return this.db.instagramJourneyExecution.findMany({
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
