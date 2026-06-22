import type { FastifyInstance } from 'fastify';
import type Razorpay from 'razorpay';
import { config } from '../../config.js';
import { normalizeRazorpayError } from '../../utils/razorpay-error.utils.js';

export class RazorpayService {
  constructor(private readonly fastify: FastifyInstance) {}

  private get client() {
    if (!this.fastify.razorpay) {
      throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
    return this.fastify.razorpay;
  }

  get keyId() {
    return config.razorpay.keyId;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw normalizeRazorpayError(err);
    }
  }

  async createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }) {
    return this.call(() =>
      this.client.orders.create({
      amount: params.amountPaise,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes ?? {},
      })
    );
  }

  async fetchOrder(orderId: string) {
    return this.call(() => this.client.orders.fetch(orderId));
  }

  async fetchPayment(paymentId: string) {
    return this.call(() => this.client.payments.fetch(paymentId));
  }

  async createSubscription(params: {
    planId: string;
    totalCount: number;
    customerNotify: number;
    notifyEmail?: string;
    notifyPhone?: string;
    notes?: Record<string, string>;
  }) {
    return this.call(() =>
      this.client.subscriptions.create({
        plan_id: params.planId,
        total_count: params.totalCount,
        customer_notify: params.customerNotify,
        ...(params.notifyEmail || params.notifyPhone
          ? {
              notify_info: {
                ...(params.notifyEmail ? { notify_email: params.notifyEmail } : {}),
                ...(params.notifyPhone ? { notify_phone: params.notifyPhone } : {}),
              },
            }
          : {}),
        notes: params.notes ?? {},
      })
    );
  }

  async fetchSubscription(subscriptionId: string) {
    return this.call(() => this.client.subscriptions.fetch(subscriptionId));
  }

  async cancelSubscription(subscriptionId: string, cancelAtCycleEnd = false) {
    return this.call(() =>
      this.client.subscriptions.cancel(subscriptionId, {
        cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0,
      })
    );
  }

  async pauseSubscription(subscriptionId: string) {
    return this.call(() => this.client.subscriptions.pause(subscriptionId, { pause_at: 'now' }));
  }

  async resumeSubscription(subscriptionId: string) {
    return this.call(() => this.client.subscriptions.resume(subscriptionId, { resume_at: 'now' }));
  }

  async refundPayment(paymentId: string, amountPaise?: number, notes?: Record<string, string>) {
    const params: Record<string, unknown> = { notes: notes ?? {} };
    if (amountPaise != null) params.amount = amountPaise;
    return this.call(() => this.client.payments.refund(paymentId, params));
  }

  async createPaymentLink(params: {
    amountPaise: number;
    description: string;
    customerName: string;
    customerPhone: string;
    customerEmail?: string | null;
    notes?: Record<string, string>;
    expireBy?: number;
  }) {
    const customerContact = params.customerPhone.replace(/\D/g, '').slice(-10);
    return this.call(() =>
      (this.client as Razorpay & {
        paymentLink: {
          create: (body: Record<string, unknown>) => Promise<{
            id: string;
            short_url: string;
            status: string;
            expire_by?: number;
          }>;
        };
      }).paymentLink.create({
        amount: params.amountPaise,
        currency: 'INR',
        description: params.description,
        customer: {
          name: params.customerName,
          contact: customerContact,
          ...(params.customerEmail ? { email: params.customerEmail } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: true,
        notes: params.notes ?? {},
        ...(params.expireBy ? { expire_by: params.expireBy } : {}),
      })
    );
  }

  async fetchPaymentLink(linkId: string) {
    return this.call(() =>
      (this.client as Razorpay & {
        paymentLink: { fetch: (id: string) => Promise<{ id: string; status: string }> };
      }).paymentLink.fetch(linkId)
    );
  }
}
