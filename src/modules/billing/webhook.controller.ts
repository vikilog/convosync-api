import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { verifyRazorpayWebhookSignature } from '../../utils/crypto.utils.js';
import type { BillingService } from './billing.service.js';
import { RazorpayService } from './razorpay.service.js';
import { WhatsAppPayService } from '../../services/whatsappPay.service.js';

type RazorpayWebhookRequest = FastifyRequest & { rawBody?: string };

export class WebhookController {
  private readonly whatsappPay: WhatsAppPayService;

  constructor(private readonly billing: BillingService, fastify: import('fastify').FastifyInstance) {
    this.whatsappPay = new WhatsAppPayService(new RazorpayService(fastify));
  }

  handleRazorpay = async (request: RazorpayWebhookRequest, reply: FastifyReply) => {
    const signature = request.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'Missing signature' });
    }

    const rawBody = request.rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: 'Missing raw body' });
    }

    const valid = verifyRazorpayWebhookSignature(
      rawBody,
      signature,
      config.razorpay.webhookSecret
    );
    if (!valid) {
      return reply.code(400).send({ error: 'Invalid webhook signature' });
    }

    let event: { event: string; payload: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody) as { event: string; payload: Record<string, unknown> };
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }

    try {
      switch (event.event) {
        case 'payment.captured':
          await this.billing.handlePaymentCaptured(event.payload);
          break;
        case 'payment.failed':
          await this.billing.handlePaymentFailed(event.payload);
          break;
        case 'subscription.activated':
        case 'subscription.authenticated':
        case 'subscription.cancelled':
        case 'subscription.paused':
        case 'subscription.resumed':
        case 'subscription.halted':
          await this.billing.handleSubscriptionEvent(event.event, event.payload);
          break;
        case 'subscription.charged':
          await this.billing.handleSubscriptionCharged(event.payload);
          break;
        case 'invoice.paid':
          await this.billing.handleInvoicePaid(event.payload);
          break;
        case 'payment_link.paid':
          await this.whatsappPay.handlePaymentLinkPaid(event.payload);
          break;
        default:
          request.log.info({ event: event.event }, 'Unhandled Razorpay webhook event');
      }

      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err, event: event.event }, 'Razorpay webhook handler error');
      return reply.code(500).send({ error: 'Webhook processing failed' });
    }
  };
}
