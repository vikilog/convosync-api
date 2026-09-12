import { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../index.js';
import { clientIpFromRequest } from '../../lib/clientIp.js';
import { getJwtUser } from '../../middleware/auth.js';
import { companyAuth } from '../../middleware/workspaceScope.js';
import {
  buildLocaleSuggestion,
  detectionHint,
  lookupGeoIp,
} from '../../services/geoip/index.js';
import { WORKSPACE_PERMISSION_DEFS } from '../../services/workspacePermissions.js';
import { requireWorkspacePermission } from '../../middleware/workspacePermissions.js';
import {
  buildCustomPlanQuote,
  CUSTOM_PLAN_PRICING_RULES,
  readCustomPlanInput,
  serializeCustomPlanSelection,
} from '../../services/customPlanPricing.js';
import {
  listSubscriptionPlans,
  serializeTenantSubscriptionPlan,
} from '../../services/subscriptionPlans.js';
import { countryToCurrency } from '../../services/billingCurrency.js';
import { serializeTrialInfo } from '../../services/trial.js';
import {
  getWorkspaceAutomationSettings,
  parsePersistentMenu,
  updateWorkspaceAutomationSettings,
} from '../../services/workspaceAutomationSettings.service.js';
import { syncPersistentMenuToMeta } from '../../services/persistentMenu.service.js';
import {
  createWorkspaceTag,
  deleteWorkspaceTag,
  isDuplicateTagNameError,
  listWorkspaceTags,
  updateWorkspaceTag,
} from '../../services/workspaceTags.service.js';
import {
  isNotificationEventType,
  listNotificationPreferences,
  upsertNotificationPreference,
} from '../../services/notificationPreferences.service.js';
import {
  getVerificationStatus,
  isVerificationTarget,
  sendVerificationOtp,
  verifyVerificationOtp,
} from '../../services/contactVerification.service.js';
import {
  automationUpdateSchema,
  companyUpdateSchema,
  customPlanQuoteSchema,
  localeDetectQuerySchema,
  localeUpdateSchema,
  notificationUpsertSchema,
  tagCreateSchema,
  tagUpdateSchema,
  verificationSendBodySchema,
  verificationVerifyBodySchema,
} from '../../routes/workspace.schemas.js';
import { getCompany, updateCompany, updateLocale } from './identity.controller.js';
import { registerWorkspaceInboxRoutes } from './workspace-inbox.routes.js';
import { registerWorkspaceMemberRoutes } from './workspace-members.routes.js';

export default async function workspaceRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/subscription', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    // Same resolution order as getWorkspacePlanFeatures (plan → active billing sub).
    // Automations / Integrations UI gates Instagram from currentPlan.channels.
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        plan: true,
        billingSubscriptions: {
          where: { status: { in: ['active', 'authenticated', 'paused'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { plan: true },
        },
      },
    });
    if (!workspace) return reply.code(404).send({ error: 'Company not found' });

    const plans = await listSubscriptionPlans();
    const trial = serializeTrialInfo(workspace);
    const effectivePlan = workspace.plan ?? workspace.billingSubscriptions[0]?.plan ?? null;
    const currentPlan = effectivePlan
      ? serializeTenantSubscriptionPlan(effectivePlan)
      : null;

    const savedInput = readCustomPlanInput(workspace.customPlanSelection);
    const customPlan = savedInput
      ? await buildCustomPlanQuote(savedInput.input, savedInput.savedAt)
      : null;

    return {
      subscriptionStatus: workspace.subscriptionStatus,
      hasPlan: Boolean(effectivePlan),
      currentPlanSlug: effectivePlan?.slug ?? null,
      currentPlan,
      trial,
      plans: plans.map(serializeTenantSubscriptionPlan),
      pricingRules: CUSTOM_PLAN_PRICING_RULES,
      customPlan,
      country: workspace.country ?? 'IN',
      currency: countryToCurrency(workspace.country),
    };
  });

  app.get(
    '/subscription/quote',
    { onRequest: auth.onRequest, schema: { querystring: customPlanQuoteSchema } },
    async (request) => {
    return buildCustomPlanQuote(request.query);
  });

  app.get('/permissions', { onRequest: auth.onRequest }, async () => {
    return { permissions: WORKSPACE_PERMISSION_DEFS };
  });

  app.post(
    '/subscription/quote',
    { onRequest: auth.onRequest, schema: { body: customPlanQuoteSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    await requireWorkspacePermission('billing')(request, reply);
    if (reply.sent) return;

    const body = request.body;
    const quote = await buildCustomPlanQuote(body, new Date().toISOString());

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { customPlanSelection: serializeCustomPlanSelection(quote) },
    });

    return { ok: true, quote };
  });

  app.get('/company', { onRequest: auth.onRequest }, getCompany);

  app.patch('/company', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: companyUpdateSchema },
  }, updateCompany);

  /** Browser-first TZ + IP country/timezone suggestion — does not persist. */
  app.get(
    '/locale/detect',
    { onRequest: auth.onRequest, schema: { querystring: localeDetectQuerySchema } },
    async (request) => {
    const browserTimezone = request.query.browserTimezone ?? null;
    const ip = clientIpFromRequest(request);
    const geo = ip ? await lookupGeoIp(ip) : null;
    const suggestion = buildLocaleSuggestion({ browserTimezone, geo });
    return {
      ...suggestion,
      countryHint: detectionHint(suggestion.countrySource, 'country'),
      timezoneHint: detectionHint(suggestion.timezoneSource, 'timezone'),
      ipFound: Boolean(ip),
    };
  });

  /** Persist workspace country + timezone (same fields as company settings). */
  app.patch('/locale', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: localeUpdateSchema },
  }, updateLocale);

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

  app.get('/verification', { onRequest: auth.onRequest }, async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      return await getVerificationStatus(userId!, workspaceId!);
    } catch (err) {
      return verificationError(reply, err);
    }
  });

  app.post(
    '/verification/send',
    { onRequest: auth.onRequest, schema: { body: verificationSendBodySchema } },
    async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      const body = request.body;
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

  app.post(
    '/verification/verify',
    { onRequest: auth.onRequest, schema: { body: verificationVerifyBodySchema } },
    async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      const body = request.body;
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

  app.get('/automation', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const settings = await getWorkspaceAutomationSettings(workspaceId);
    if (!settings) return reply.code(404).send({ error: 'Company not found' });
    return settings;
  });

  app.patch('/automation', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: automationUpdateSchema },
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
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

  app.get('/tags', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return listWorkspaceTags(workspaceId);
  });

  app.post('/tags', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: tagCreateSchema },
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
    try {
      return reply.code(201).send(await createWorkspaceTag(workspaceId, body));
    } catch (err) {
      if (isDuplicateTagNameError(err)) {
        return reply.code(409).send({ error: 'A tag with this name already exists.' });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create tag' });
    }
  });

  app.patch('/tags/:tagId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: tagUpdateSchema },
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { tagId } = request.params as { tagId: string };
    const body = request.body;
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
  app.delete('/tags/:tagId', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
  }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const { tagId } = request.params as { tagId: string };
    await deleteWorkspaceTag(workspaceId, tagId);
    return { success: true };
  });

  app.get('/notifications', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return { preferences: await listNotificationPreferences(prisma, workspaceId) };
  });

  app.patch('/notifications', {
    onRequest: [...auth.onRequest, requireWorkspacePermission('settings')],
    schema: { body: notificationUpsertSchema },
  }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
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

  await registerWorkspaceMemberRoutes(fastify);
  await registerWorkspaceInboxRoutes(fastify);
}
