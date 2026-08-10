/**
 * Central activity emit: authenticated mutating API → WorkspaceNotification.
 * Bell is gated by forBell (default false here); rich domain emits stay separate.
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { emitNotification } from '../services/notifications/emitNotification.js';
import { resolveRouteActivity } from '../services/notifications/routeActivityMap.js';

function jwtBits(request: FastifyRequest): { userId?: string; workspaceId?: string } {
  const u = request.user as { userId?: string; workspaceId?: string } | undefined;
  return { userId: u?.userId, workspaceId: u?.workspaceId };
}

const userActivityPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onResponse', async (request, reply) => {
    try {
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const method = request.method.toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;

      const { userId, workspaceId } = jwtBits(request);
      if (!userId || !workspaceId) return;

      const urlPath = (request.url || '').split('?')[0] || '';
      const routePattern = request.routeOptions?.url;

      const params = (request.params ?? {}) as Record<string, string | undefined>;
      const spec = resolveRouteActivity({
        method,
        urlPath,
        routePattern,
        params,
      });
      if (!spec) return;

      void emitNotification({
        workspaceId,
        type: spec.type,
        category: spec.category,
        title: spec.title,
        message: spec.message,
        entityType: spec.entityType ?? null,
        entityId: spec.entityId ?? null,
        actorUserId: userId,
        forBell: spec.forBell ?? false,
        metadata: {
          source: 'route_activity',
          routeKey: spec.routeKey,
          method,
          path: urlPath,
        },
      });
    } catch (err) {
      request.log.warn({ err }, 'user-activity hook failed');
    }
  });
};

export default fp(userActivityPlugin, { name: 'user-activity' });
