import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuthBilling } from '../../middleware/workspaceScope.js';
import { requireWorkspacePermission } from '../../middleware/workspacePermissions.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { RazorpayService } from './razorpay.service.js';
import { WebhookController } from './webhook.controller.js';
import {
  billingLimitQuerySchema,
  billingMonthQuerySchema,
  cancelSubscriptionSchema,
  createOrderSchema,
  createSubscriptionSchema,
  refundSchema,
  updateWalletSchema,
  validateCouponSchema,
  verifyOrderSchema,
  verifySubscriptionSchema,
} from './billing.schemas.js';

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export default async function billingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const razorpayService = new RazorpayService(fastify);
  const billingService = new BillingService(razorpayService);
  const controller = new BillingController(billingService);
  const webhookController = new WebhookController(billingService, fastify);
  const auth = companyAuthBilling;
  const billingWrite = {
    onRequest: [...companyAuthBilling.onRequest, requireWorkspacePermission('billing')],
  };

  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.includes('/webhooks/razorpay')) return payload;

    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    (request as RawBodyRequest).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });

  // Razorpay HMAC / always-200 after signature — do not add Zod body schema.
  app.post('/webhooks/razorpay', webhookController.handleRazorpay);

  app.get('/billing/plans', auth, controller.listPlans);
  app.get('/billing/workspace', auth, controller.getWorkspaceBilling);
  app.get('/billing/offers', auth, controller.listPendingOffers);
  app.get(
    '/billing/invoices',
    { ...auth, schema: { querystring: billingLimitQuerySchema } },
    controller.listTransactions
  );
  app.get(
    '/billing/usage',
    { ...auth, schema: { querystring: billingMonthQuerySchema } },
    controller.getUsageCost
  );
  app.get('/billing/wallet', auth, controller.getWallet);
  app.get(
    '/billing/wallet/transactions',
    { ...auth, schema: { querystring: billingLimitQuerySchema } },
    controller.listWalletTransactions
  );
  app.patch(
    '/billing/wallet',
    { ...billingWrite, schema: { body: updateWalletSchema } },
    controller.updateWallet
  );
  // AUTO_RECHARGE_DISABLED — re-enable later
  // fastify.post('/billing/wallet/auto-recharge/setup', billingWrite, controller.createAutoRechargeSetup);
  app.post(
    '/billing/order/create',
    { ...billingWrite, schema: { body: createOrderSchema } },
    controller.createOrder
  );
  app.post(
    '/billing/order/verify',
    { ...billingWrite, schema: { body: verifyOrderSchema } },
    controller.verifyOrder
  );
  app.post(
    '/billing/subscription/create',
    { ...billingWrite, schema: { body: createSubscriptionSchema } },
    controller.createSubscription
  );
  app.post(
    '/billing/coupon/validate',
    { ...auth, schema: { body: validateCouponSchema } },
    controller.validateCoupon
  );
  app.post(
    '/billing/subscription/verify',
    { ...billingWrite, schema: { body: verifySubscriptionSchema } },
    controller.verifySubscription
  );
  app.post(
    '/billing/subscription/cancel',
    { ...billingWrite, schema: { body: cancelSubscriptionSchema } },
    controller.cancelSubscription
  );
  app.post('/billing/subscription/pause', billingWrite, controller.pauseSubscription);
  app.post('/billing/subscription/resume', billingWrite, controller.resumeSubscription);
  app.post('/billing/refund', { ...billingWrite, schema: { body: refundSchema } }, controller.refund);
}
