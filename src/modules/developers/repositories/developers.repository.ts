import type { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { DEVELOPER_ACTION_TYPES } from '../types/developers.types.js';
import type { DeveloperActionType } from '../types/developers.types.js';

function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export class DevelopersRepository {
  constructor(private readonly db: PrismaClient) {}

  async ensureIncomingWebhook(workspaceId: string) {
    const existing = await this.db.developerIncomingWebhook.findUnique({
      where: { workspaceId },
    });
    if (existing) return existing;

    return this.db.developerIncomingWebhook.create({
      data: {
        workspaceId,
        slug: randomToken(12),
        secret: randomToken(32),
      },
    });
  }

  async updateIncomingWebhook(
    workspaceId: string,
    data: {
      enabled?: boolean;
      subscribedEvents?: string[];
      secret?: string;
    }
  ) {
    await this.ensureIncomingWebhook(workspaceId);
    return this.db.developerIncomingWebhook.update({
      where: { workspaceId },
      data,
    });
  }

  async findIncomingBySlug(slug: string) {
    return this.db.developerIncomingWebhook.findUnique({
      where: { slug },
      include: { workspace: { select: { id: true, name: true } } },
    });
  }

  async touchIncomingLastEvent(workspaceId: string) {
    return this.db.developerIncomingWebhook.update({
      where: { workspaceId },
      data: { lastEventAt: new Date() },
    });
  }

  async listOutgoingWebhooks(workspaceId: string) {
    return this.db.developerOutgoingWebhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createOutgoingWebhook(
    workspaceId: string,
    data: {
      name: string;
      url: string;
      secret?: string;
      enabled: boolean;
      subscribedEvents: string[];
      maxRetries: number;
      timeoutMs: number;
    }
  ) {
    return this.db.developerOutgoingWebhook.create({
      data: { workspaceId, ...data },
    });
  }

  async updateOutgoingWebhook(
    workspaceId: string,
    id: string,
    data: Partial<{
      name: string;
      url: string;
      secret: string | null;
      enabled: boolean;
      subscribedEvents: string[];
      maxRetries: number;
      timeoutMs: number;
    }>
  ) {
    const row = await this.db.developerOutgoingWebhook.findFirst({
      where: { id, workspaceId },
    });
    if (!row) return null;
    return this.db.developerOutgoingWebhook.update({ where: { id }, data });
  }

  async deleteOutgoingWebhook(workspaceId: string, id: string) {
    const row = await this.db.developerOutgoingWebhook.findFirst({
      where: { id, workspaceId },
    });
    if (!row) return false;
    await this.db.developerOutgoingWebhook.delete({ where: { id } });
    return true;
  }

  async listOutgoingForEvent(workspaceId: string, eventType: string) {
    return this.db.developerOutgoingWebhook.findMany({
      where: {
        workspaceId,
        enabled: true,
        subscribedEvents: { has: eventType },
      },
    });
  }

  async createWebhookLog(data: {
    workspaceId: string;
    direction: 'incoming' | 'outgoing';
    outgoingWebhookId?: string;
    eventType: string;
    payload?: unknown;
    status: string;
    statusCode?: number;
    responseBody?: string;
    attempt?: number;
    errorMessage?: string;
    nextRetryAt?: Date;
  }) {
    return this.db.developerWebhookLog.create({
      data: {
        workspaceId: data.workspaceId,
        direction: data.direction,
        outgoingWebhookId: data.outgoingWebhookId,
        eventType: data.eventType,
        payload: data.payload as object | undefined,
        status: data.status,
        statusCode: data.statusCode,
        responseBody: data.responseBody,
        attempt: data.attempt ?? 1,
        errorMessage: data.errorMessage,
        nextRetryAt: data.nextRetryAt,
      },
    });
  }

  async listWebhookLogs(
    workspaceId: string,
    opts: { direction?: 'incoming' | 'outgoing'; limit: number }
  ) {
    return this.db.developerWebhookLog.findMany({
      where: {
        workspaceId,
        ...(opts.direction ? { direction: opts.direction } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
  }

  async ensureDefaultActions(workspaceId: string) {
    const existing = await this.db.developerAction.findMany({
      where: { workspaceId },
      select: { actionType: true },
    });
    const have = new Set(existing.map((a) => a.actionType));
    const missing = DEVELOPER_ACTION_TYPES.filter((t) => !have.has(t));
    if (missing.length === 0) return;

    await this.db.developerAction.createMany({
      data: missing.map((actionType) => ({
        workspaceId,
        actionType,
        name: formatDefaultActionName(actionType),
        method: 'POST',
        url: '',
        headers: {},
        enabled: false,
      })),
    });
  }

  async listActions(workspaceId: string) {
    await this.ensureDefaultActions(workspaceId);
    return this.db.developerAction.findMany({
      where: { workspaceId },
      orderBy: { actionType: 'asc' },
    });
  }

  async upsertAction(
    workspaceId: string,
    actionType: DeveloperActionType,
    data: {
      name: string;
      method: string;
      url: string;
      headers: Record<string, string>;
      timeoutMs: number;
      enabled: boolean;
    }
  ) {
    await this.ensureDefaultActions(workspaceId);
    return this.db.developerAction.upsert({
      where: { workspaceId_actionType: { workspaceId, actionType } },
      create: { workspaceId, actionType, ...data },
      update: data,
    });
  }

  async enqueueSyncEvent(workspaceId: string, eventType: string, payload?: unknown) {
    return this.db.developerSyncEvent.create({
      data: {
        workspaceId,
        eventType,
        payload: payload as object | undefined,
        status: 'pending',
      },
    });
  }

  async claimPendingSyncEvents(limit = 5) {
    const pending = await this.db.developerSyncEvent.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const row of pending) {
      await this.db.developerSyncEvent.update({
        where: { id: row.id },
        data: { status: 'processing' },
      });
    }
    return pending;
  }

  async completeSyncEvent(id: string) {
    return this.db.developerSyncEvent.update({
      where: { id },
      data: { status: 'completed', processedAt: new Date(), errorMessage: null },
    });
  }

  async failSyncEvent(id: string, errorMessage: string) {
    return this.db.developerSyncEvent.update({
      where: { id },
      data: { status: 'failed', processedAt: new Date(), errorMessage },
    });
  }

  async countSyncEvents(workspaceId: string, status: string) {
    return this.db.developerSyncEvent.count({ where: { workspaceId, status } });
  }

  async getLatestSyncEvent(workspaceId: string) {
    return this.db.developerSyncEvent.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAiKnowledgeConfig(workspaceId: string) {
    return this.db.aiKnowledgeConfig.findUnique({ where: { workspaceId } });
  }

  async getAiKnowledgeRecord(workspaceId: string, venueId: string) {
    return this.db.aiKnowledge.findUnique({
      where: { workspaceId_venueId: { workspaceId, venueId } },
    });
  }

  async listSyncEvents(workspaceId: string, limit = 20) {
    return this.db.developerSyncEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

function formatDefaultActionName(actionType: DeveloperActionType): string {
  return actionType
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
