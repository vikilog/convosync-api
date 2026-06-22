import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getJwtUser } from '../../middleware/auth.js';
import { formatBillingError } from '../../utils/razorpay-error.utils.js';
import { getWorkspaceUsageCost } from '../../services/usageCost.service.js';
import type { BillingService } from './billing.service.js';

const createOrderSchema = z.object({
  amountPaise: z.number().int().positive().optional(),
  purpose: z.enum(['addon', 'custom_plan', 'plan_purchase', 'one_time']).optional(),
  addonType: z
    .enum([
      'contacts',
      'team_members',
      'ai_agents',
      'channels',
      'ai_tokens',
      'campaigns',
      'emails',
    ])
    .optional(),
  quantity: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const verifyOrderSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

const createSubscriptionSchema = z.object({
  planId: z.string(),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
});

const verifySubscriptionSchema = z.object({
  razorpay_payment_id: z.string(),
  razorpay_subscription_id: z.string(),
  razorpay_signature: z.string(),
});

const cancelSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().optional(),
});

const refundSchema = z.object({
  paymentId: z.string(),
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export class BillingController {
  constructor(private readonly billing: BillingService) {}

  listPlans = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const plans = await this.billing.listPlans();
      return reply.send({ plans });
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  getWorkspaceBilling = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const data = await this.billing.getWorkspaceBilling(workspaceId);
      return reply.send(data);
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  listTransactions = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query ?? {});

    try {
      const transactions = await this.billing.listBillingTransactions(
        workspaceId,
        query.limit ?? 50
      );
      return reply.send({ transactions });
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  getUsageCost = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const query = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
      .parse(request.query ?? {});

    try {
      const usage = await getWorkspaceUsageCost(workspaceId, query.month);
      return reply.send(usage);
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  createOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = createOrderSchema.parse(request.body);
      const result = await this.billing.createOrder(workspaceId, body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  verifyOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = verifyOrderSchema.parse(request.body);
      const result = await this.billing.verifyOrder(workspaceId, body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  createSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = createSubscriptionSchema.parse(request.body);
      const result = await this.billing.createSubscription(workspaceId, body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  verifySubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = verifySubscriptionSchema.parse(request.body);
      const result = await this.billing.verifySubscriptionPayment(workspaceId, body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  cancelSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = cancelSubscriptionSchema.parse(request.body ?? {});
      const result = await this.billing.cancelSubscription(
        workspaceId,
        body.cancelAtPeriodEnd ?? true
      );
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  pauseSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const result = await this.billing.pauseSubscription(workspaceId);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  resumeSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const result = await this.billing.resumeSubscription(workspaceId);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  refund = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, role } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    if (role !== 'admin') return reply.code(403).send({ error: 'Admin only' });

    try {
      const body = refundSchema.parse(request.body);
      const result = await this.billing.refundPayment(
        workspaceId,
        body.paymentId,
        body.amountPaise,
        body.reason
      );
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };
}

function formatError(err: unknown): string {
  return formatBillingError(err);
}
