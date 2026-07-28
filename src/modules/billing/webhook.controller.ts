import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { verifyRazorpayWebhookSignature } from '../../utils/crypto.utils.js';
import type { BillingService } from './billing.service.js';
import { RazorpayService } from './razorpay.service.js';
import { WhatsAppPayService } from '../../services/whatsappPay.service.js';
import type { RazorpayWebhookEvent } from './razorpay-webhook.types.js';
import {
  webhookPaymentEntity,
  webhookSubscriptionEntity,
} from './razorpay-webhook.types.js';

type RazorpayWebhookRequest = FastifyRequest & { rawBody?: string };

function resolveWebhookEventId(
  request: RazorpayWebhookRequest,
  event: RazorpayWebhookEvent
): string {
  const headerId = request.headers['x-razorpay-event-id'];
  if (typeof headerId === 'string' && headerId.trim()) return headerId.trim();

  const payment = webhookPaymentEntity(event.payload);
  if (payment?.id) return `${event.event}:${payment.id}`;

  const subscription = webhookSubscriptionEntity(event.payload);
  if (subscription?.id) return `${event.event}:${subscription.id}`;

  const createdAt = event.created_at ?? 0;
  return `${event.event}:${createdAt}`;
}

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

    let event: RazorpayWebhookEvent;
    try {
      event = JSON.parse(rawBody) as RazorpayWebhookEvent;
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }

    if (!event?.event || typeof event.event !== 'string') {
      return reply.code(400).send({ error: 'Invalid event payload' });
    }

    const eventId = resolveWebhookEventId(request, event);

    try {
      await prisma.razorpayWebhookLog.create({
        data: { eventId, event: event.event },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.send({ ok: true, duplicate: true });
      }
      console.error('[webhooks.razorpay] Failed to insert WebhookLog', { eventId, err });
      // Still continue — better to risk double-process than drop a payment event permanently
    }

    try {
      switch (event.event) {
        case 'payment.captured':
          await this.billing.handlePaymentCaptured(event.payload ?? {});
          break;
        case 'payment.failed':
          await this.billing.handlePaymentFailed(event.payload ?? {});
          break;
        case 'subscription.activated':
        case 'subscription.authenticated':
        case 'subscription.cancelled':
        case 'subscription.paused':
        case 'subscription.resumed':
        case 'subscription.halted':
          await this.billing.handleSubscriptionEvent(event.event, event.payload ?? {});
          break;
        case 'subscription.charged':
          await this.billing.handleSubscriptionCharged(event.payload ?? {});
          break;
        case 'invoice.paid':
          await this.billing.handleInvoicePaid(event.payload ?? {});
          break;
        case 'payment_link.paid':
          await this.whatsappPay.handlePaymentLinkPaid(event.payload ?? {});
          break;
        default:
          request.log.info({ event: event.event }, 'Unhandled Razorpay webhook event');
      }

      return reply.send({ ok: true });
    } catch (err) {
      // Valid signature: always 200 so Razorpay does not retry endlessly.
      console.error('[webhooks.razorpay] Handler error after valid signature', {
        event: event.event,
        eventId,
        err,
      });
      request.log.error({ err, event: event.event, eventId }, 'Razorpay webhook handler error');
      return reply.send({ ok: true });
    }
  };
}
