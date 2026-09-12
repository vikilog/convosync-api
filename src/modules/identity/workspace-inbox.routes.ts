import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../../middleware/auth.js';
import { requireWorkspacePermission } from '../../middleware/workspacePermissions.js';
import { companyAuth } from '../../middleware/workspaceScope.js';
import {
  inboxBehaviorUpdateSchema,
  inboxGroupMemberBodySchema,
  inboxGroupNameSchema,
  inboxRuleCreateSchema,
  inboxRuleReorderSchema,
  inboxRuleUpdateSchema,
} from '../../routes/workspace.schemas.js';
import {
  addInboxGroupMember,
  createInboxGroup,
  createInboxRule,
  deleteInboxGroup,
  deleteInboxRule,
  getInboxBehaviorSettings,
  listInboxGroups,
  listInboxRules,
  removeInboxGroupMember,
  reorderInboxRules,
  updateInboxBehaviorSettings,
  updateInboxGroup,
  updateInboxRule,
} from '../../services/inboxBehavior.service.js';

export async function registerWorkspaceInboxRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/inbox-behavior', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const settings = await getInboxBehaviorSettings(workspaceId);
    if (!settings) return reply.code(404).send({ error: 'Company not found' });
    return settings;
  });

  app.patch(
    '/inbox-behavior',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxBehaviorUpdateSchema },
    },
    async (request) => {
      const { workspaceId } = getJwtUser(request);
      return updateInboxBehaviorSettings(workspaceId, request.body);
    }
  );

  app.get('/inbox-groups', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { groups: await listInboxGroups(workspaceId) };
  });

  app.post(
    '/inbox-groups',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxGroupNameSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      try {
        return reply.code(201).send(await createInboxGroup(workspaceId, request.body.name));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create group' });
      }
    }
  );

  app.patch(
    '/inbox-groups/:groupId',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxGroupNameSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { groupId } = request.params as { groupId: string };
      try {
        return await updateInboxGroup(workspaceId, groupId, request.body.name);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to update group' });
      }
    }
  );

  app.delete(
    '/inbox-groups/:groupId',
    { onRequest: [...auth.onRequest, requireWorkspacePermission('settings')] },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { groupId } = request.params as { groupId: string };
      try {
        return await deleteInboxGroup(workspaceId, groupId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to delete group' });
      }
    }
  );

  app.post(
    '/inbox-groups/:groupId/members',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxGroupMemberBodySchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { groupId } = request.params as { groupId: string };
      try {
        return await addInboxGroupMember(workspaceId, groupId, request.body.membershipId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to add member' });
      }
    }
  );

  app.delete(
    '/inbox-groups/:groupId/members/:membershipId',
    { onRequest: [...auth.onRequest, requireWorkspacePermission('settings')] },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { groupId, membershipId } = request.params as { groupId: string; membershipId: string };
      try {
        return await removeInboxGroupMember(workspaceId, groupId, membershipId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to remove member' });
      }
    }
  );

  app.get('/inbox-rules', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { rules: await listInboxRules(workspaceId) };
  });

  app.post(
    '/inbox-rules',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxRuleCreateSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      try {
        return reply.code(201).send(await createInboxRule(workspaceId, request.body));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create rule' });
      }
    }
  );

  // Must be registered before the generic /:ruleId route below.
  app.patch(
    '/inbox-rules/reorder',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxRuleReorderSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      try {
        return { rules: await reorderInboxRules(workspaceId, request.body.orderedIds) };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to reorder rules' });
      }
    }
  );

  app.patch(
    '/inbox-rules/:ruleId',
    {
      onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
      schema: { body: inboxRuleUpdateSchema },
    },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { ruleId } = request.params as { ruleId: string };
      try {
        return await updateInboxRule(workspaceId, ruleId, request.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to update rule' });
      }
    }
  );

  app.delete(
    '/inbox-rules/:ruleId',
    { onRequest: [...auth.onRequest, requireWorkspacePermission('settings')] },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      const { ruleId } = request.params as { ruleId: string };
      try {
        return await deleteInboxRule(workspaceId, ruleId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to delete rule' });
      }
    }
  );
}
