import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { listWhatsAppAccounts } from '../services/whatsappAccounts.js';
import {
  addWorkspaceMember,
  isAllowedMemberRole,
  listWorkspaceMembersFormatted,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from '../services/workspaceMemberAdmin.js';
import {
  isWorkspacePermission,
  WORKSPACE_PERMISSION_DEFS,
} from '../services/workspacePermissions.js';
import {
  requireUsersManageAccess,
  requireWorkspacePermission,
} from '../middleware/workspacePermissions.js';
import {
  buildCustomPlanQuote,
  CUSTOM_PLAN_PRICING_RULES,
  readCustomPlanInput,
  serializeCustomPlanSelection,
} from '../services/customPlanPricing.js';
import {
  listSubscriptionPlans,
  serializeTenantSubscriptionPlan,
} from '../services/subscriptionPlans.js';
import { serializeTrialInfo } from '../services/trial.js';

const customPlanQuoteSchema = z.object({
  contacts: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.contacts.min).max(CUSTOM_PLAN_PRICING_RULES.limits.contacts.max),
  aiAgents: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.aiAgents.min).max(CUSTOM_PLAN_PRICING_RULES.limits.aiAgents.max),
  teamMembers: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.teamMembers.min).max(CUSTOM_PLAN_PRICING_RULES.limits.teamMembers.max),
  channels: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.channels.min).max(CUSTOM_PLAN_PRICING_RULES.limits.channels.max),
  emails: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.emails.min).max(CUSTOM_PLAN_PRICING_RULES.limits.emails.max),
});

const memberRoleSchema = z.enum(['admin', 'agent']);

const permissionsSchema = z
  .array(z.string())
  .optional()
  .transform((values) => (values ?? []).filter((value) => isWorkspacePermission(value)));

const inboxScopeSchema = z
  .object({
    mode: z.enum(['all', 'restricted']),
    channels: z.array(z.enum(['whatsapp', 'instagram', 'messenger'])).optional(),
    accounts: z
      .object({
        whatsapp: z.array(z.string().min(1)).optional(),
        instagram: z.array(z.string().min(1)).optional(),
        messenger: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  })
  .optional();

const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).optional(),
  password: z.string().min(8).optional(),
  role: memberRoleSchema.default('agent'),
  permissions: permissionsSchema,
  inboxScope: inboxScopeSchema,
});

const updateMemberSchema = z.object({
  role: memberRoleSchema,
  permissions: permissionsSchema,
  inboxScope: inboxScopeSchema,
});

function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { role } = getJwtUser(request);
  if (role !== 'admin') {
    reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

const companyUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  legalName: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  email: z.union([z.string().email(), z.literal(''), z.null()]).optional(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  timezone: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  logoUrl: z.string().max(2000).optional().nullable(),
});

function normalizeOptionalUrls<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  for (const key of ['website', 'email', 'logoUrl'] as const) {
    if (key in out && out[key] === '') out[key] = null;
  }
  return out as T;
}

export default async function workspaceRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/subscription', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { plan: true },
    });
    if (!workspace) return reply.code(404).send({ error: 'Company not found' });

    const plans = await listSubscriptionPlans();
    const trial = serializeTrialInfo(workspace);
    const currentPlan = workspace.plan
      ? serializeTenantSubscriptionPlan(workspace.plan)
      : null;

    const savedInput = readCustomPlanInput(workspace.customPlanSelection);
    const customPlan = savedInput
      ? await buildCustomPlanQuote(savedInput.input, savedInput.savedAt)
      : null;

    return {
      subscriptionStatus: workspace.subscriptionStatus,
      hasPlan: Boolean(workspace.plan),
      currentPlanSlug: workspace.plan?.slug ?? null,
      currentPlan,
      trial,
      plans: plans.map(serializeTenantSubscriptionPlan),
      pricingRules: CUSTOM_PLAN_PRICING_RULES,
      customPlan,
    };
  });

  fastify.get('/subscription/quote', { onRequest: auth.onRequest }, async (request) => {
    const query = customPlanQuoteSchema.parse(request.query);
    return buildCustomPlanQuote(query);
  });

  fastify.get('/permissions', { onRequest: auth.onRequest }, async () => {
    return { permissions: WORKSPACE_PERMISSION_DEFS };
  });

  fastify.post('/subscription/quote', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    await requireWorkspacePermission('billing')(request, reply);
    if (reply.sent) return;

    const body = customPlanQuoteSchema.parse(request.body);
    const quote = await buildCustomPlanQuote(body, new Date().toISOString());

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { customPlanSelection: serializeCustomPlanSelection(quote) },
    });

    return { ok: true, quote };
  });

  fastify.get('/company', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { plan: { select: { name: true, slug: true } } },
    });
    if (!workspace) return reply.code(404).send({ error: 'Company not found' });

    const whatsappAccounts = await listWhatsAppAccounts(workspaceId);
    const trial = serializeTrialInfo(workspace);

    return {
      ...workspace,
      whatsappAccounts,
      connected: whatsappAccounts.length > 0 || !!workspace.waNumberId,
      trial,
    };
  });

  fastify.patch('/company', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    const body = normalizeOptionalUrls(companyUpdateSchema.parse(request.body));

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: body,
    });

    return workspace;
  });

  fastify.get('/members', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return listWorkspaceMembersFormatted(workspaceId);
  });

  fastify.post('/members', {
    onRequest: [...auth.onRequest, requireUsersManageAccess],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = addMemberSchema.parse(request.body);

    try {
      const result = await addWorkspaceMember({
        workspaceId,
        email: body.email,
        name: body.name,
        password: body.password,
        role: body.role,
        permissions: body.permissions,
        inboxScope: body.inboxScope,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add member';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/members/:membershipId', {
    onRequest: [...auth.onRequest, requireUsersManageAccess],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { membershipId } = request.params as { membershipId: string };
    const body = updateMemberSchema.parse(request.body);

    if (!isAllowedMemberRole(body.role)) {
      return reply.code(400).send({ error: 'Invalid role' });
    }

    try {
      const member = await updateWorkspaceMember({
        workspaceId,
        membershipId,
        role: body.role,
        permissions: body.permissions,
        inboxScope: body.inboxScope,
      });
      return member;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update member';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.delete('/members/:membershipId', {
    onRequest: [...auth.onRequest, requireUsersManageAccess],
  }, async (request, reply) => {
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
  });
}
