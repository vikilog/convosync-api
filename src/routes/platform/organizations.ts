import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../index.js';
import { getJwtUser } from '../../middleware/auth.js';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import {
  getPlatformOrganizationById,
  getPlatformOrganizationStats,
  getPlatformOrganizationUsageCost,
  listPlatformOrganizations,
} from '../../services/platformOrganizations.js';
import {
  assignPlanToWorkspace,
  createWorkspaceImpersonationSession,
  getWorkspaceAuditTrail,
  reactivateWorkspace,
  removePlanFromWorkspace,
  setWorkspaceAgentEnabled,
  suspendWorkspace,
  creditOrganizationWallet,
  updateOrganizationCompany,
  updateOrganizationOwner,
  updateWorkspaceLimits,
} from '../../services/platformOrganizationAdmin.js';
import { pushOrganizationToCrmContact } from '../../services/pushOrganizationCrmContact.js';
import { RazorpayService } from '../../modules/billing/razorpay.service.js';
import {
  activateWorkspaceSubscription,
  extendWorkspaceTrial,
} from '../../services/trial.js';
import {
  getRequestIp,
  PLATFORM_AUDIT_ACTIONS,
  recordAuditEvent,
} from '../../services/platformAudit.js';
import {
  cancelBillingOffer,
  createBillingOffer,
  deleteBillingOffer,
  listBillingOffersForWorkspace,
} from '../../services/billingOffers.js';
import { extractRazorpayErrorDetails } from '../../utils/razorpay-error.utils.js';

const orgIdParams = z.object({ id: z.string() });
const orgOfferParams = z.object({ id: z.string(), offerId: z.string() });
const orgAgentParams = z.object({ id: z.string(), agentId: z.string() });

const orgListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

const usageCostQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

const trialExtendBody = z.object({
  days: z.coerce.number().int().min(1).max(365),
  reason: z.string().trim().min(3).max(500),
});

const impersonateBody = z.object({ userId: z.string().min(1).optional() });

const limitsBody = z.object({
  contactsLimit: z.coerce.number().int().min(0).optional(),
  teamMembersLimit: z.coerce.number().int().min(1).optional(),
  aiAgentsLimit: z.coerce.number().int().min(0).optional(),
  channelsLimit: z.coerce.number().int().min(1).optional(),
  aiTokensIncluded: z.coerce.number().int().min(0).optional(),
  campaignsLimit: z.coerce.number().int().min(0).optional(),
  emailsLimit: z.coerce.number().int().min(0).optional(),
});

const assignPlanBody = z.object({ planSlug: z.string().trim().min(1) });

const billingOffersQuery = z.object({
  status: z.enum(['pending', 'paid', 'cancelled', 'all']).optional(),
});

const billingOfferBody = z.object({
  planId: z.string().trim().min(1),
  billingCycle: z.enum(['monthly', 'annual']).default('monthly'),
  currency: z.enum(['INR', 'USD']),
  amountMinor: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  checkoutKind: z.enum(['subscription', 'payment_link']).default('subscription'),
  allowPaymentLinkFallback: z.boolean().optional().default(false),
});

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
  companySize: z.string().optional().nullable(),
});

const ownerUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional(),
});

const agentEnabledBody = z.object({ isEnabled: z.boolean() });

const creditWalletBody = z.object({
  amountCc: z.coerce.number().positive().max(1_000_000),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export default async function platformOrganizationRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/stats', async () => {
    return getPlatformOrganizationStats();
  });

  app.get('/', { schema: { querystring: orgListQuery } }, async (request) => {
    return listPlatformOrganizations(request.query);
  });

  app.get(
    '/:id/usage-cost',
    { schema: { params: orgIdParams, querystring: usageCostQuery } },
    async (request, reply) => {
    const { id } = request.params;
    const query = request.query;
    const data = await getPlatformOrganizationUsageCost(id, query.month);
    if (!data) return reply.code(404).send({ error: 'Organization not found' });
    return data;
  });

  app.get('/:id', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    const org = await getPlatformOrganizationById(id);
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    return org;
  });

  app.post(
    '/:id/trial/extend',
    { schema: { params: orgIdParams, body: trialExtendBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    const admin = getJwtUser(request);

    try {
      const workspace = await extendWorkspaceTrial(id, {
        extraDays: body.days,
        reason: body.reason,
        platformAdminId: admin.platformAdminId,
      });
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialStartedAt: workspace.trialStartedAt?.toISOString() ?? null,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to extend trial';
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/:id/activate', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;

    try {
      const workspace = await activateWorkspaceSubscription(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to activate subscription';
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/:id/suspend', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    try {
      const workspace = await suspendWorkspace(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to suspend workspace';
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/:id/reactivate', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    try {
      const workspace = await reactivateWorkspace(id);
      return {
        ok: true,
        workspaceId: workspace.id,
        subscriptionStatus: workspace.subscriptionStatus,
        trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reactivate workspace';
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/:id/whatsapp-flow/enable', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const workspace = await prisma.workspace.update({
        where: { id },
        data: { whatsappFlowsEnabled: true },
        select: { id: true, name: true, whatsappFlowsEnabled: true },
      });
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_WHATSAPP_FLOW_ENABLE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'organization',
        severity: 'info',
        ipAddress: ip,
        metadata: { targetLabel: workspace.name },
      });
      return { ok: true, workspaceId: workspace.id, whatsappFlowsEnabled: workspace.whatsappFlowsEnabled };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to enable WhatsApp Flow';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/:id/impersonate',
    { schema: { params: orgIdParams, body: impersonateBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const session = await createWorkspaceImpersonationSession(
        fastify,
        id,
        admin.platformAdminId!,
        body.userId
      );
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_IMPERSONATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'security',
        severity: 'warning',
        ipAddress: ip,
        metadata: {
          targetLabel: session.workspace.name,
          details: body.userId
            ? `Opened impersonation session as ${session.user.email} for ${session.workspace.name}`
            : `Opened impersonation session for ${session.workspace.name}`,
          workspaceId: id,
          targetUserId: session.user.id,
          targetUserEmail: session.user.email,
          ownerEmail: session.user.email,
        },
      });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to impersonate workspace';
      return reply.code(400).send({ error: message });
    }
  });

  app.patch(
    '/:id/limits',
    { schema: { params: orgIdParams, body: limitsBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    try {
      const limits = await updateWorkspaceLimits(id, body);
      return { ok: true, limits };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update limits';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/:id/assign-plan',
    { schema: { params: orgIdParams, body: assignPlanBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const result = await assignPlanToWorkspace(id, body.planSlug);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_PLAN_ASSIGN,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'subscription',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: result.planName,
          details: `Assigned ${result.planName} plan`,
          planSlug: result.planSlug,
          planName: result.planName,
        },
      });
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to assign plan';
      return reply.code(400).send({ error: message });
    }
  });

  app.get(
    '/:id/billing-offers',
    { schema: { params: orgIdParams, querystring: billingOffersQuery } },
    async (request, reply) => {
    const { id } = request.params;
    const query = request.query;
    try {
      const offers = await listBillingOffersForWorkspace(id, {
        status: query.status ?? 'all',
      });
      return { offers };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list billing offers';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/:id/billing-offers',
    { schema: { params: orgIdParams, body: billingOfferBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const offer = await createBillingOffer(fastify, id, {
        planId: body.planId,
        billingCycle: body.billingCycle,
        currency: body.currency,
        amountMinor: body.amountMinor,
        note: body.note,
        checkoutKind: body.checkoutKind,
        allowPaymentLinkFallback: body.allowPaymentLinkFallback,
        createdByPlatformAdminId: admin.platformAdminId,
      });
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_CREATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'billing',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: offer.plan?.name ?? offer.planId,
          details: `Created ${offer.offerType} offer for ${offer.plan?.name ?? offer.planId} (${offer.currency} ${offer.amountMinor})`,
          offerId: offer.id,
          offerType: offer.offerType,
          currency: offer.currency,
          amountMinor: offer.amountMinor,
          shortUrl: offer.shortUrl,
        },
      });
      return reply.code(201).send({ offer });
    } catch (err) {
      const details = extractRazorpayErrorDetails(err);
      const message =
        details.message ||
        (err instanceof Error ? err.message : 'Failed to create billing offer');
      return reply.code(400).send({
        error: message,
        razorpay: {
          description: details.description,
          field: details.field,
          reason: details.reason,
          source: details.source,
          step: details.step,
          code: details.code,
          statusCode: details.statusCode,
          rawError: details.rawError,
        },
      });
    }
  });

  app.post(
    '/:id/billing-offers/:offerId/cancel',
    { schema: { params: orgOfferParams } },
    async (request, reply) => {
    const { id, offerId } = request.params;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const offer = await cancelBillingOffer(fastify, id, offerId);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_CANCEL,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'billing',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: offer.plan?.name ?? offer.planId,
          details: `Cancelled billing offer ${offer.id}`,
          offerId: offer.id,
        },
      });
      return { offer };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel billing offer';
      return reply.code(400).send({ error: message });
    }
  });

  app.delete(
    '/:id/billing-offers/:offerId',
    { schema: { params: orgOfferParams } },
    async (request, reply) => {
    const { id, offerId } = request.params;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const offer = await deleteBillingOffer(fastify, id, offerId);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_DELETE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'billing',
        severity: 'warning',
        ipAddress: ip,
        metadata: {
          targetLabel: offer.plan?.name ?? offer.planId,
          details: `Deleted billing offer ${offer.id}`,
          offerId: offer.id,
          offerType: offer.offerType,
          priorStatus: offer.status,
        },
      });
      return { ok: true, offer };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete billing offer';
      return reply.code(400).send({ error: message });
    }
  });

  app.patch('/:id', { schema: { params: orgIdParams, body: companyUpdateSchema } }, async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const company = await updateOrganizationCompany(id, body);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_UPDATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'organization',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: company.name,
          details: `Updated organization profile for ${company.name}`,
          fields: Object.keys(body),
        },
      });
      return { ok: true, company };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update company';
      return reply.code(400).send({ error: message });
    }
  });

  app.patch(
    '/:id/owner',
    { schema: { params: orgIdParams, body: ownerUpdateSchema } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const result = await updateOrganizationOwner(id, body);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_OWNER_UPDATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'organization',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: result.owner.email,
          details: `Updated owner profile (${result.owner.email})`,
          ownerId: result.owner.id,
          fields: Object.keys(body),
        },
      });
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update owner';
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/:id/remove-plan', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      // Cancel Razorpay first while local rows are still "live"
      const live = await prisma.billingSubscription.findMany({
        where: {
          workspaceId: id,
          status: { in: ['active', 'authenticated', 'paused'] },
          razorpaySubscriptionId: { not: null },
        },
        select: { razorpaySubscriptionId: true },
      });

      if (live.length > 0 && fastify.razorpay) {
        const razorpay = new RazorpayService(fastify);
        for (const row of live) {
          if (!row.razorpaySubscriptionId) continue;
          try {
            await razorpay.cancelSubscription(row.razorpaySubscriptionId, false);
          } catch {
            // Local remove still proceeds — Razorpay may already be cancelled
          }
        }
      }

      const result = await removePlanFromWorkspace(id);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_PLAN_REMOVE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'subscription',
        severity: 'warning',
        ipAddress: ip,
        metadata: {
          targetLabel: result.removedPlanName ?? id,
          details: result.removedPlanName
            ? `Removed ${result.removedPlanName} plan`
            : 'Removed plan and cancelled billing subscriptions',
          removedPlanSlug: result.removedPlanSlug,
          cancelledBillingSubs: result.cancelledBillingSubs,
        },
      });
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove plan';
      return reply.code(400).send({ error: message });
    }
  });

  app.patch(
    '/:id/agents/:agentId',
    { schema: { params: orgAgentParams, body: agentEnabledBody } },
    async (request, reply) => {
    const { id, agentId } = request.params;
    const body = request.body;

    try {
      const agent = await setWorkspaceAgentEnabled(id, agentId, body.isEnabled);
      return { ok: true, agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update agent';
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/:id/audit', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getWorkspaceAuditTrail(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load audit trail';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/:id/credit-wallet',
    { schema: { params: orgIdParams, body: creditWalletBody } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const result = await creditOrganizationWallet(id, {
        amountCc: body.amountCc,
        note: body.note,
        platformAdminId: admin.platformAdminId!,
        idempotencyKey: body.idempotencyKey,
      });

      if (!result.alreadyApplied) {
        recordAuditEvent({
          action: PLATFORM_AUDIT_ACTIONS.ORG_WALLET_CREDIT,
          actor: { id: admin.platformAdminId, role: admin.role },
          entityType: 'workspace',
          entityId: id,
          category: 'billing',
          severity: 'info',
          ipAddress: ip,
          metadata: {
            details: `Added ${result.amountCc} CC to wallet`,
            amountCc: result.amountCc,
            amountPaise: result.amountPaise,
            invoiceId: result.invoiceId,
            note: body.note ?? null,
          },
        });
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to credit wallet';
      return reply.code(400).send({ error: message });
    }
  });

  /** Push tenant owner into ConvoSync sales CRM as a Contact (WhatsApp/IG follow-up). */
  app.post('/:id/push-crm-contact', { schema: { params: orgIdParams } }, async (request, reply) => {
    const { id } = request.params;
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);

    try {
      const result = await pushOrganizationToCrmContact(id);

      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ORG_CRM_CONTACT_PUSH,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'workspace',
        entityId: id,
        category: 'organization',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          details: result.message,
          contactId: result.contactId,
          created: result.created,
          alreadyExists: result.alreadyExists,
          phone: result.phone,
          email: result.email,
        },
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to push CRM contact';
      return reply.code(400).send({ error: message });
    }
  });
}
