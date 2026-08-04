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
import { validateAvatarValue } from '../services/userProfile.js';
import {
  getWorkspaceAutomationSettings,
  parsePersistentMenu,
  updateWorkspaceAutomationSettings,
} from '../services/workspaceAutomationSettings.service.js';
import { syncPersistentMenuToMeta } from '../services/persistentMenu.service.js';
import {
  createWorkspaceTag,
  deleteWorkspaceTag,
  isDuplicateTagNameError,
  listWorkspaceTags,
  updateWorkspaceTag,
} from '../services/workspaceTags.service.js';
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
} from '../services/inboxBehavior.service.js';
import {
  isNotificationEventType,
  listNotificationPreferences,
  upsertNotificationPreference,
} from '../services/notificationPreferences.service.js';
import {
  getVerificationStatus,
  isVerificationTarget,
  sendVerificationOtp,
  verifyVerificationOtp,
} from '../services/contactVerification.service.js';

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
  autoAssignEligible: z.boolean().optional(),
  assignmentLimit: z.number().int().min(0).max(1000).nullable().optional(),
});

const inboxRuleBusinessHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).optional(),
});

const inboxRuleConditionsSchema = z.object({
  channels: z.array(z.enum(['whatsapp', 'instagram', 'messenger'])).optional(),
  contactTags: z.array(z.string().min(1)).optional(),
  businessHours: inboxRuleBusinessHoursSchema.optional(),
});

const inboxRuleCreateSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  conditions: inboxRuleConditionsSchema,
  actionType: z.enum(['group', 'user']),
  actionGroupId: z.string().min(1).optional().nullable(),
  actionUserId: z.string().min(1).optional().nullable(),
});

const inboxRuleUpdateSchema = inboxRuleCreateSchema.partial();

const inboxBehaviorUpdateSchema = z.object({
  mode: z.enum(['off', 'basic', 'advanced']).optional(),
  timezone: z.string().nullable().optional(),
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
  logoUrl: z.union([z.string(), z.null()]).optional(),
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
    if ('logoUrl' in body) {
      body.logoUrl = validateAvatarValue(body.logoUrl as string | null | undefined);
    }

    const existing = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { email: true, phone: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Company not found' });

    const data: Record<string, unknown> = { ...body };
    if ('email' in body) {
      const nextEmail =
        body.email === null || body.email === ''
          ? null
          : String(body.email).trim().toLowerCase();
      const prevEmail = existing.email?.trim().toLowerCase() ?? null;
      if (nextEmail !== prevEmail) data.emailVerifiedAt = null;
    }
    if ('phone' in body) {
      const nextPhone =
        body.phone === null || body.phone === '' ? null : String(body.phone).replace(/\D/g, '');
      const prevPhone = existing.phone?.replace(/\D/g, '') ?? null;
      if (nextPhone !== prevPhone) data.phoneVerifiedAt = null;
    }

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data,
    });

    return workspace;
  });

  const verificationError = (reply: FastifyReply, err: unknown) => {
    const message = err instanceof Error ? err.message : 'Request failed';
    const status =
      /too many|incorrect|expired|not requested|not configured|valid mobile|valid company|add a company|changed since|resend|whatsapp/i.test(
        message
      )
        ? 400
        : 500;
    return reply.code(status).send({ error: message });
  };

  fastify.get('/verification', { onRequest: auth.onRequest }, async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      return await getVerificationStatus(userId!, workspaceId!);
    } catch (err) {
      return verificationError(reply, err);
    }
  });

  fastify.post('/verification/send', { onRequest: auth.onRequest }, async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      const body = z
        .object({
          target: z.string(),
          email: z.string().trim().max(254).optional(),
          phone: z.string().trim().max(32).optional(),
        })
        .parse(request.body ?? {});
      if (!isVerificationTarget(body.target)) {
        return reply.code(400).send({ error: 'Invalid verification target' });
      }
      if (body.target !== 'user_email') {
        await requireWorkspacePermission('settings')(request, reply);
        if (reply.sent) return;
      }
      return await sendVerificationOtp({
        userId: userId!,
        workspaceId: workspaceId!,
        target: body.target,
        email: body.email,
        phone: body.phone,
      });
    } catch (err) {
      return verificationError(reply, err);
    }
  });

  fastify.post('/verification/verify', { onRequest: auth.onRequest }, async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      const body = z
        .object({
          target: z.string(),
          code: z.string().trim().min(4).max(12),
        })
        .parse(request.body ?? {});
      if (!isVerificationTarget(body.target)) {
        return reply.code(400).send({ error: 'Invalid verification target' });
      }
      if (body.target !== 'user_email') {
        await requireWorkspacePermission('settings')(request, reply);
        if (reply.sent) return;
      }
      return await verifyVerificationOtp({
        userId: userId!,
        workspaceId: workspaceId!,
        target: body.target,
        code: body.code,
      });
    } catch (err) {
      return verificationError(reply, err);
    }
  });

  const automationUpdateSchema = z.object({
    automationsPaused: z.boolean().optional(),
    defaultReplyEnabled: z.boolean().optional(),
    defaultReplyText: z.string().max(2000).optional().nullable(),
    persistentMenu: z
      .object({
        enabled: z.boolean(),
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              title: z.string().min(1).max(30),
              type: z.enum(['postback', 'web_url']),
              payload: z.string().max(1000).optional(),
              url: z.string().url().max(500).optional(),
            })
          )
          .max(5),
      })
      .optional(),
    syncMenu: z.boolean().optional(),
  });

  fastify.get('/automation', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const settings = await getWorkspaceAutomationSettings(workspaceId);
    if (!settings) return reply.code(404).send({ error: 'Company not found' });
    return settings;
  });

  fastify.patch('/automation', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = automationUpdateSchema.parse(request.body);
    const settings = await updateWorkspaceAutomationSettings(workspaceId, {
      automationsPaused: body.automationsPaused,
      defaultReplyEnabled: body.defaultReplyEnabled,
      defaultReplyText: body.defaultReplyText,
      persistentMenu: body.persistentMenu
        ? parsePersistentMenu(body.persistentMenu)
        : undefined,
    });

    let menuSync: Awaited<ReturnType<typeof syncPersistentMenuToMeta>> | undefined;
    if (body.syncMenu || body.persistentMenu) {
      menuSync = await syncPersistentMenuToMeta(workspaceId);
    }

    return { ...settings, menuSync };
  });

  fastify.get('/tags', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return listWorkspaceTags(workspaceId);
  });

  const tagCreateSchema = z.object({
    name: z.string().min(1).max(64),
    folder: z.string().max(64).nullable().optional(),
  });

  fastify.post('/tags', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = tagCreateSchema.parse(request.body);
    try {
      return reply.code(201).send(await createWorkspaceTag(workspaceId, body));
    } catch (err) {
      if (isDuplicateTagNameError(err)) {
        return reply.code(409).send({ error: 'A tag with this name already exists.' });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create tag' });
    }
  });

  const tagUpdateSchema = tagCreateSchema.partial();

  fastify.patch('/tags/:tagId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { tagId } = request.params as { tagId: string };
    const body = tagUpdateSchema.parse(request.body);
    try {
      return await updateWorkspaceTag(workspaceId, tagId, body);
    } catch (err) {
      if (isDuplicateTagNameError(err)) {
        return reply.code(409).send({ error: 'A tag with this name already exists.' });
      }
      const message = err instanceof Error ? err.message : 'Failed to update tag';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });

  // Registry delete only — contacts keep whatever tag values they already have (see WorkspaceTag docs).
  fastify.delete('/tags/:tagId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { tagId } = request.params as { tagId: string };
    await deleteWorkspaceTag(workspaceId, tagId);
    return { success: true };
  });

  const notificationChannelsSchema = z.object({
    email: z
      .object({
        enabled: z.boolean(),
        recipients: z.object({
          workspaceEmail: z.boolean(),
          userIds: z.array(z.string().min(1)).max(50),
          extraEmails: z.array(z.string().email()).max(20),
        }),
        subjectTemplate: z.string().min(1).max(200).optional(),
        bodyTemplate: z.string().min(1).max(5000).optional(),
      })
      .optional(),
    whatsapp: z
      .object({
        enabled: z.boolean(),
        phoneNumbers: z.array(z.string().min(8).max(20)).max(20),
        userIds: z.array(z.string().min(1)).max(50),
        templateId: z.string().min(1).nullable(),
        variableMap: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    inApp: z.object({ enabled: z.boolean() }).optional(),
  });

  const notificationUpsertSchema = z.object({
    eventType: z.string().min(1),
    enabled: z.boolean().optional(),
    channels: notificationChannelsSchema.optional(),
  });

  fastify.get('/notifications', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { preferences: await listNotificationPreferences(prisma, workspaceId) };
  });

  fastify.patch('/notifications', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = notificationUpsertSchema.parse(request.body);
    if (!isNotificationEventType(body.eventType)) {
      return reply.code(400).send({ error: `Unknown event type: ${body.eventType}` });
    }
    const preference = await upsertNotificationPreference(prisma, workspaceId, {
      eventType: body.eventType,
      enabled: body.enabled,
      channels: body.channels,
    });
    return { preference };
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
        autoAssignEligible: body.autoAssignEligible,
        assignmentLimit: body.assignmentLimit,
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

  fastify.get('/inbox-behavior', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const settings = await getInboxBehaviorSettings(workspaceId);
    if (!settings) return reply.code(404).send({ error: 'Company not found' });
    return settings;
  });

  fastify.patch('/inbox-behavior', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = inboxBehaviorUpdateSchema.parse(request.body);
    return updateInboxBehaviorSettings(workspaceId, body);
  });

  fastify.get('/inbox-groups', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { groups: await listInboxGroups(workspaceId) };
  });

  fastify.post('/inbox-groups', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    try {
      return reply.code(201).send(await createInboxGroup(workspaceId, body.name));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create group' });
    }
  });

  fastify.patch('/inbox-groups/:groupId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { groupId } = request.params as { groupId: string };
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    try {
      return await updateInboxGroup(workspaceId, groupId, body.name);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to update group' });
    }
  });

  fastify.delete('/inbox-groups/:groupId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { groupId } = request.params as { groupId: string };
    try {
      return await deleteInboxGroup(workspaceId, groupId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to delete group' });
    }
  });

  fastify.post('/inbox-groups/:groupId/members', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { groupId } = request.params as { groupId: string };
    const body = z.object({ membershipId: z.string().min(1) }).parse(request.body);
    try {
      return await addInboxGroupMember(workspaceId, groupId, body.membershipId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to add member' });
    }
  });

  fastify.delete('/inbox-groups/:groupId/members/:membershipId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { groupId, membershipId } = request.params as { groupId: string; membershipId: string };
    try {
      return await removeInboxGroupMember(workspaceId, groupId, membershipId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to remove member' });
    }
  });

  fastify.get('/inbox-rules', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { rules: await listInboxRules(workspaceId) };
  });

  fastify.post('/inbox-rules', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = inboxRuleCreateSchema.parse(request.body);
    try {
      return reply.code(201).send(await createInboxRule(workspaceId, body));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create rule' });
    }
  });

  // Must be registered before the generic /:ruleId route below.
  fastify.patch('/inbox-rules/reorder', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = z.object({ orderedIds: z.array(z.string().min(1)) }).parse(request.body);
    try {
      return { rules: await reorderInboxRules(workspaceId, body.orderedIds) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to reorder rules' });
    }
  });

  fastify.patch('/inbox-rules/:ruleId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { ruleId } = request.params as { ruleId: string };
    const body = inboxRuleUpdateSchema.parse(request.body);
    try {
      return await updateInboxRule(workspaceId, ruleId, body);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to update rule' });
    }
  });

  fastify.delete('/inbox-rules/:ruleId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { ruleId } = request.params as { ruleId: string };
    try {
      return await deleteInboxRule(workspaceId, ruleId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to delete rule' });
    }
  });
}
