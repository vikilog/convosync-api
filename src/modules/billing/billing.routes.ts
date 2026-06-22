import type { FastifyInstance, FastifyRequest } from 'fastify';
import { companyAuthBilling } from '../../middleware/workspaceScope.js';
import { requireWorkspacePermission } from '../../middleware/workspacePermissions.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { RazorpayService } from './razorpay.service.js';
import { WebhookController } from './webhook.controller.js';

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export default async function billingRoutes(fastify: FastifyInstance) {
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

  fastify.post('/webhooks/razorpay', webhookController.handleRazorpay);

  fastify.get('/billing/plans', auth, controller.listPlans);
  fastify.get('/billing/workspace', auth, controller.getWorkspaceBilling);
  fastify.get('/billing/invoices', auth, controller.listTransactions);
  fastify.get('/billing/usage', auth, controller.getUsageCost);
  fastify.post('/billing/order/create', billingWrite, controller.createOrder);
  fastify.post('/billing/order/verify', billingWrite, controller.verifyOrder);
  fastify.post('/billing/subscription/create', billingWrite, controller.createSubscription);
  fastify.post('/billing/subscription/verify', billingWrite, controller.verifySubscription);
  fastify.post('/billing/subscription/cancel', billingWrite, controller.cancelSubscription);
  fastify.post('/billing/subscription/pause', billingWrite, controller.pauseSubscription);
  fastify.post('/billing/subscription/resume', billingWrite, controller.resumeSubscription);
  fastify.post('/billing/refund', billingWrite, controller.refund);
}
