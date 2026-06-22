import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GoogleBusinessSyncType, Prisma } from '@prisma/client';
import { getJwtUser } from '../../../middleware/auth.js';

function workspaceId(request: FastifyRequest): string {
  return getJwtUser(request).workspaceId;
}
import { googleBusinessAccountService } from '../business-profile/services/google-business-account.service.js';
import { googleBusinessLocationService } from '../business-profile/services/google-business-location.service.js';
import { googleBusinessReviewService } from '../business-profile/services/google-business-review.service.js';
import { googleBusinessMetricService } from '../business-profile/services/google-business-metric.service.js';
import { googleBusinessSyncService } from '../business-profile/services/google-business-sync.service.js';
import { gbpSyncLogRepository } from '../business-profile/repositories/gbp-sync-log.repository.js';

const SYNC_TYPES = new Set<GoogleBusinessSyncType>([
  'accounts',
  'locations',
  'reviews',
  'metrics',
  'cache_rebuild',
]);

export class GbpController {
  listAccounts = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.query as { connectionId?: string };
    if (!connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const ws = workspaceId(request);
    const accounts = await googleBusinessAccountService.listFromCache(ws, connectionId);
    return reply.send({ accounts });
  };

  listLocations = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId, accountId } = request.query as {
      connectionId?: string;
      accountId?: string;
    };
    if (!connectionId || !accountId) {
      return reply.code(400).send({ error: 'connectionId and accountId required' });
    }
    const ws = workspaceId(request);
    const locations = await googleBusinessLocationService.listByAccountFromCache(
      ws,
      connectionId,
      accountId
    );
    return reply.send({ locations });
  };

  listReviews = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.query as { connectionId?: string };
    const { locationId } = request.params as { locationId?: string };
    if (!connectionId || !locationId) {
      return reply.code(400).send({ error: 'connectionId and locationId required' });
    }
    const ws = workspaceId(request);
    const reviews = await googleBusinessReviewService.listByLocationFromCache(
      ws,
      connectionId,
      locationId
    );
    return reply.send({ reviews });
  };

  listMetrics = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.query as { connectionId?: string };
    const { locationId } = request.params as { locationId?: string };
    if (!connectionId || !locationId) {
      return reply.code(400).send({ error: 'connectionId and locationId required' });
    }
    const ws = workspaceId(request);
    const metrics = await googleBusinessMetricService.listByLocationFromCache(
      ws,
      connectionId,
      locationId
    );
    return reply.send({ metrics });
  };

  enqueueSync = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      connectionId: string;
      syncType: GoogleBusinessSyncType;
      accountId?: string;
      locationId?: string;
      force?: boolean;
    };
    if (!body.connectionId || !body.syncType) {
      return reply.code(400).send({ error: 'connectionId and syncType required' });
    }
    if (!SYNC_TYPES.has(body.syncType)) {
      return reply.code(400).send({ error: 'Invalid syncType' });
    }
    const ws = workspaceId(request);
    const jobId = await googleBusinessSyncService.enqueue(
      ws,
      body.connectionId,
      body.syncType,
      {
        accountId: body.accountId,
        locationId: body.locationId,
        force: body.force,
      }
    );
    return reply.send({ jobId, status: 'queued' });
  };

  syncStatus = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.query as { connectionId?: string };
    if (!connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const ws = workspaceId(request);
    const status = await googleBusinessSyncService.getSyncStatus(ws, connectionId);
    return reply.send(status);
  };

  syncLogs = async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId, limit } = request.query as {
      connectionId?: string;
      limit?: string;
    };
    if (!connectionId) return reply.code(400).send({ error: 'connectionId required' });
    const ws = workspaceId(request);
    const logs = await gbpSyncLogRepository.list(
      ws,
      connectionId,
      limit ? Number(limit) : 50
    );
    return reply.send({ logs });
  };

  /** Legacy route — returns cached locations only (no Google API). */
  cachedLocationsLegacy = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { connectionId: string; accountName?: string; accountId?: string };
    if (!body.connectionId) {
      return reply.code(400).send({ error: 'connectionId required' });
    }
    const ws = workspaceId(request);

    let accountId = body.accountId;
    if (!accountId && body.accountName) {
      const accounts = await googleBusinessAccountService.listFromCache(
        ws,
        body.connectionId
      );
      const match = accounts.find((a) => a.googleAccountName === body.accountName);
      accountId = match?.id;
    }
    if (!accountId) {
      return reply.send({ locations: [], note: 'No cached account — run accounts sync first' });
    }

    const locations = await googleBusinessLocationService.listByAccountFromCache(
      ws,
      body.connectionId,
      accountId
    );
    return reply.send({
      locations: locations.map((l) => ({
        id: l.id,
        name: l.googleLocationName,
        title: l.title,
        storefrontAddress: l.address,
        regularHours: l.regularHours,
        metadata: l.metadata,
      })),
    });
  };
}
