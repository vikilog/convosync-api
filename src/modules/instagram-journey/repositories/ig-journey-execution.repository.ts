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
        version: { increment: 1 },
        lastExecutedAt: new Date(),
      },
    });
  }

  /**
   * Version-checked variant for the few entry points where two independent
   * external triggers can race to wake the SAME waiting execution — a reply
   * arriving at almost the exact moment its WAIT timer fires. Returns false
   * (no row touched) when `expectedVersion` is stale, meaning the other
   * trigger already won the race; the caller should stop rather than also
   * advance the execution.
   */
  async updateProgressIfVersion(
    id: string,
    expectedVersion: number,
    data: {
      currentNodeId?: string | null;
      status?: string;
      context?: Record<string, unknown>;
    }
  ): Promise<boolean> {
    const result = await this.db.instagramJourneyExecution.updateMany({
      where: { id, version: expectedVersion },
      data: {
        ...(data.currentNodeId !== undefined ? { currentNodeId: data.currentNodeId } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.context !== undefined
          ? { context: data.context as Prisma.InputJsonValue }
          : {}),
        version: { increment: 1 },
        lastExecutedAt: new Date(),
      },
    });
    return result.count > 0;
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

  /** Any journey already running/waiting for this contact — used to gate fan-out so only one automation owns a chat at a time. */
  findAnyActiveForContact(workspaceId: string, contactId: string) {
    return this.db.instagramJourneyExecution.findFirst({
      where: {
        contactId,
        status: { in: ['running', 'waiting'] },
        journey: { workspaceId },
      },
      select: { id: true, journeyId: true },
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
