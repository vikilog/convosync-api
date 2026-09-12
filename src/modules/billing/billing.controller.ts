import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../middleware/auth.js';
import { formatBillingError } from '../../utils/razorpay-error.utils.js';
import { getWorkspaceUsageCost } from '../../services/usageCost.service.js';
import {
  getWalletSummary,
  listWalletTransactions,
} from '../../services/wallet.service.js';
import { WALLET_TOPUP_PRESETS_INR, PLATFORM_MONTHLY_FEE_INR } from '../../services/wallet.constants.js';
import type { BillingService } from './billing.service.js';
import { listPendingBillingOffers } from '../../services/billingOffers.js';
import type {
  BillingLimitQuery,
  BillingMonthQuery,
  CancelSubscriptionBody,
  CreateOrderBody,
  CreateSubscriptionBody,
  RefundBody,
  UpdateWalletBody,
  ValidateCouponBody,
  VerifyOrderBody,
  VerifySubscriptionBody,
} from './billing.schemas.js';

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

  listPendingOffers = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const offers = await listPendingBillingOffers(workspaceId);
      return reply.send({ offers });
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  listTransactions = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const query = request.query as BillingLimitQuery;

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

    const query = request.query as BillingMonthQuery;

    try {
      const usage = await getWorkspaceUsageCost(workspaceId, query.month);
      return reply.send(usage);
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  getWallet = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const wallet = await this.billing.getWallet(workspaceId);
      return reply.send({
        ...wallet,
        platformMonthlyFeeInr: PLATFORM_MONTHLY_FEE_INR,
        topUpPresetsInr: [...WALLET_TOPUP_PRESETS_INR],
      });
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  listWalletTransactions = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const query = request.query as BillingLimitQuery;

    try {
      const transactions = await listWalletTransactions(workspaceId, query.limit ?? 50);
      return reply.send({ transactions });
    } catch (err) {
      return reply.code(500).send({ error: formatError(err) });
    }
  };

  updateWallet = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body as UpdateWalletBody;

    try {
      const wallet = await this.billing.updateWallet(workspaceId, body);
      return reply.send(wallet);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  /* AUTO_RECHARGE_DISABLED — re-enable later
  createAutoRechargeSetup = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const result = await this.billing.createAutoRechargeSetup(workspaceId);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };
  */

  createOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = request.body as CreateOrderBody;
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
      const body = request.body as VerifyOrderBody;
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
      const body = request.body as CreateSubscriptionBody;
      const result = await this.billing.createSubscription(workspaceId, body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  validateCoupon = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = request.body as ValidateCouponBody;
      const result = await this.billing.validateCoupon(body);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: formatError(err) });
    }
  };

  verifySubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const body = request.body as VerifySubscriptionBody;
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
      const body = (request.body ?? {}) as CancelSubscriptionBody;
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
      const body = request.body as RefundBody;
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
