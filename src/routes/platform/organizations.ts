import { FastifyInstance } from 'fastify';
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

export default async function platformOrganizationRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/stats', async () => {
    return getPlatformOrganizationStats();
  });

  fastify.get('/', async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
      })
      .parse(request.query);

    return listPlatformOrganizations(query);
  });

  fastify.get('/:id/usage-cost', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query);
    const data = await getPlatformOrganizationUsageCost(id, query.month);
    if (!data) return reply.code(404).send({ error: 'Organization not found' });
    return data;
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const org = await getPlatformOrganizationById(id);
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    return org;
  });

  fastify.post('/:id/trial/extend', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        days: z.coerce.number().int().min(1).max(365),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(request.body);

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

  fastify.post('/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string };

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

  fastify.post('/:id/suspend', async (request, reply) => {
    const { id } = request.params as { id: string };
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

  fastify.post('/:id/reactivate', async (request, reply) => {
    const { id } = request.params as { id: string };
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

  fastify.post('/:id/impersonate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const session = await createWorkspaceImpersonationSession(fastify, id, admin.platformAdminId!);
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
          details: `Opened impersonation session for ${session.workspace.name}`,
          workspaceId: id,
          ownerEmail: session.user.email,
        },
      });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to impersonate workspace';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:id/limits', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        contactsLimit: z.coerce.number().int().min(0).optional(),
        teamMembersLimit: z.coerce.number().int().min(1).optional(),
        aiAgentsLimit: z.coerce.number().int().min(0).optional(),
        channelsLimit: z.coerce.number().int().min(1).optional(),
        aiTokensIncluded: z.coerce.number().int().min(0).optional(),
        campaignsLimit: z.coerce.number().int().min(0).optional(),
        emailsLimit: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.body);

    try {
      const limits = await updateWorkspaceLimits(id, body);
      return { ok: true, limits };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update limits';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/assign-plan', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ planSlug: z.string().trim().min(1) }).parse(request.body);
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

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = companyUpdateSchema.parse(request.body ?? {});
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

  fastify.patch('/:id/owner', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(2).optional(),
        phone: z.string().optional().nullable(),
        email: z.string().email().optional(),
      })
      .parse(request.body ?? {});
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

  fastify.post('/:id/remove-plan', async (request, reply) => {
    const { id } = request.params as { id: string };
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

  fastify.patch('/:id/agents/:agentId', async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    const body = z.object({ isEnabled: z.boolean() }).parse(request.body);

    try {
      const agent = await setWorkspaceAgentEnabled(id, agentId, body.isEnabled);
      return { ok: true, agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update agent';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/:id/audit', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await getWorkspaceAuditTrail(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load audit trail';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/:id/credit-wallet', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        amountCc: z.coerce.number().positive().max(1_000_000),
        note: z.string().trim().max(500).optional(),
        idempotencyKey: z.string().trim().min(8).max(128).optional(),
      })
      .parse(request.body);
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
}
