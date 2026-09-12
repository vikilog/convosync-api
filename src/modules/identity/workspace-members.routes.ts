import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../../middleware/auth.js';
import { requireUsersManageAccess } from '../../middleware/workspacePermissions.js';
import { companyAuth } from '../../middleware/workspaceScope.js';
import { addMemberSchema, updateMemberSchema } from '../../routes/workspace.schemas.js';
import {
  addWorkspaceMember,
  isAllowedMemberRole,
  listWorkspaceMembersFormatted,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from '../../services/workspaceMemberAdmin.js';

export async function registerWorkspaceMemberRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/members', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return listWorkspaceMembersFormatted(workspaceId);
  });

  app.post(
    '/members',
    {
      onRequest: [...auth.onRequest, requireUsersManageAccess],
      schema: { body: addMemberSchema },
    },
    async (request, reply) => {
      const { workspaceId, userId } = getJwtUser(request);
      const body = request.body;
      try {
        const result = await addWorkspaceMember({
          workspaceId,
          email: body.email,
          name: body.name,
          password: body.password,
          role: body.role,
          permissions: body.permissions,
          inboxScope: body.inboxScope,
          actorUserId: userId,
        });
        return reply.code(201).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add member';
        return reply.code(400).send({ error: message });
      }
    }
  );

  app.patch(
    '/members/:membershipId',
    {
      onRequest: [...auth.onRequest, requireUsersManageAccess],
      schema: { body: updateMemberSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { membershipId } = request.params as { membershipId: string };
      const body = request.body;

      if (!isAllowedMemberRole(body.role)) {
        return reply.code(400).send({ error: 'Invalid role' });
      }

      try {
        return await updateWorkspaceMember({
          workspaceId,
          membershipId,
          role: body.role,
          autoAssignEligible: body.autoAssignEligible,
          assignmentLimit: body.assignmentLimit,
          permissions: body.permissions,
          inboxScope: body.inboxScope,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update member';
        return reply.code(400).send({ error: message });
      }
    }
  );

  app.delete(
    '/members/:membershipId',
    { onRequest: [...auth.onRequest, requireUsersManageAccess] },
    async (request, reply) => {
      const { workspaceId, userId } = getJwtUser(request);
      const { membershipId } = request.params as { membershipId: string };
      try {
        return await removeWorkspaceMember({
          workspaceId,
          membershipId,
          actorUserId: userId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove member';
        return reply.code(400).send({ error: message });
      }
    }
  );
}
