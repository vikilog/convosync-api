import type { AIKnowledgeService } from '../../ai-knowledge/services/ai-knowledge.service.js';
import { eventBus } from '../../journey/events/event-bus.js';
import type { DevelopersRepository } from '../repositories/developers.repository.js';
import type { AiSyncDashboard, DeveloperSyncEventRecord } from '../types/developers.types.js';

export class AiSyncDashboardService {
  constructor(
    private readonly repo: DevelopersRepository,
    private readonly aiKnowledgeService: AIKnowledgeService
  ) {}

  async getDashboard(workspaceId: string): Promise<AiSyncDashboard> {
    const config = await this.repo.getAiKnowledgeConfig(workspaceId);
    const venueId = config?.venueId ?? null;
    const record = venueId
      ? await this.repo.getAiKnowledgeRecord(workspaceId, venueId)
      : null;

    const latestEvent = await this.repo.getLatestSyncEvent(workspaceId);
    const pendingQueueJobs = await this.repo.countSyncEvents(workspaceId, 'pending');
    const failedEvents = await this.repo.countSyncEvents(workspaceId, 'failed');

    const data = (record?.data ?? {}) as Record<string, unknown>;

    let connectionStatus: AiSyncDashboard['connectionStatus'] = 'not_configured';
    if (config?.connectionString && venueId) {
      if (record?.status === 'syncing') connectionStatus = 'syncing';
      else if (record?.status === 'failed') connectionStatus = 'failed';
      else if (record?.status === 'success') connectionStatus = 'connected';
      else connectionStatus = 'disconnected';
    }

    return {
      connectionStatus,
      lastSyncTime: record?.syncedAt?.toISOString() ?? null,
      lastEventTime: latestEvent?.createdAt.toISOString() ?? null,
      venueId,
      knowledgeHealth: {
        services: countArray(data.services),
        products: countArray(data.products),
        customers: countArray(data.customersSummary),
        staff: countArray(data.staff),
      },
      pendingQueueJobs,
      failedEvents,
    };
  }

  async listRecentEvents(workspaceId: string, limit = 20): Promise<DeveloperSyncEventRecord[]> {
    const all = await this.repo.listSyncEvents(workspaceId, limit);

    return all.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      status: e.status,
      errorMessage: e.errorMessage,
      createdAt: e.createdAt.toISOString(),
      processedAt: e.processedAt?.toISOString() ?? null,
    }));
  }

  /** Enqueue knowledge rebuild — processed by sync event worker. */
  async requestRebuild(workspaceId: string) {
    const config = await this.repo.getAiKnowledgeConfig(workspaceId);
    if (!config?.connectionString || !config.venueId) {
      throw new Error('AI Knowledge is not configured. Set venue and MongoDB connection first.');
    }

    const event = await this.repo.enqueueSyncEvent(workspaceId, 'knowledge.rebuild', {
      venueId: config.venueId,
      requestedAt: new Date().toISOString(),
    });

    return {
      eventId: event.id,
      status: 'pending' as const,
      message: 'Knowledge rebuild queued',
    };
  }

  async processSyncEvent(event: {
    id: string;
    workspaceId: string;
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    if (event.eventType !== 'knowledge.rebuild') {
      await this.repo.failSyncEvent(event.id, `Unsupported event type: ${event.eventType}`);
      return;
    }

    const config = await this.repo.getAiKnowledgeConfig(event.workspaceId);
    if (!config?.connectionString || !config.venueId) {
      await this.repo.failSyncEvent(event.id, 'AI Knowledge config missing');
      return;
    }

    try {
      await this.aiKnowledgeService.sync(event.workspaceId, {
        connectionString: config.connectionString,
        venueId: config.venueId,
      });
      await this.repo.completeSyncEvent(event.id);
      void eventBus.emit('knowledge.rebuild.requested', {
        workspaceId: event.workspaceId,
        venueId: config.venueId,
        eventId: event.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rebuild failed';
      await this.repo.failSyncEvent(event.id, message);
      throw err;
    }
  }
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
