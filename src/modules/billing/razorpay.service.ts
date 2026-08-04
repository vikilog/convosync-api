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
    paymentCapture?: boolean;
  }) {
    return this.call(() =>
      this.client.orders.create({
        amount: params.amountPaise,
        currency: 'INR',
        receipt: params.receipt,
        notes: params.notes ?? {},
        ...(params.paymentCapture ? { payment_capture: true } : {}),
      })
    );
  }

  /** Create a Razorpay Subscriptions plan (monthly or yearly). Returns plan_xxx id. */
  async createPlan(params: {
    name: string;
    amountPaise: number;
    period: 'monthly' | 'yearly';
    description?: string;
    notes?: Record<string, string>;
  }) {
    const created = await this.call(() =>
      this.client.plans.create({
        period: params.period,
        interval: 1,
        item: {
          name: params.name,
          amount: params.amountPaise,
          currency: 'INR',
          ...(params.description ? { description: params.description } : {}),
        },
        notes: params.notes ?? {},
      })
    );
    return created as { id: string };
  }

  async fetchOrder(orderId: string) {
    return this.call(() => this.client.orders.fetch(orderId));
  }

  async fetchPayment(paymentId: string) {
    return this.call(() => this.client.payments.fetch(paymentId));
  }

  async createSubscription(params: {
    planId: string;
    customerId?: string;
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
        ...(params.customerId ? { customer_id: params.customerId } : {}),
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

  async createCustomer(params: {
    name: string;
    email?: string;
    contact?: string;
    notes?: Record<string, string>;
  }) {
    return this.call(() =>
      this.client.customers.create({
        name: params.name,
        ...(params.email ? { email: params.email } : {}),
        ...(params.contact ? { contact: params.contact } : {}),
        fail_existing: '0',
        notes: params.notes ?? {},
      })
    );
  }

  async fetchCustomerTokens(customerId: string) {
    return this.call(() =>
      this.client.customers.fetchTokens(customerId)
    );
  }

  async fetchCustomer(customerId: string) {
    return this.call(() => this.client.customers.fetch(customerId));
  }

  async chargeWithToken(params: {
    amountPaise: number;
    orderId: string;
    customerId: string;
    tokenId: string;
    email?: string;
    contact?: string;
    description?: string;
  }) {
    if (!params.email?.trim()) {
      throw new Error('Customer email is required for auto-recharge.');
    }
    if (!params.contact?.trim()) {
      throw new Error('Customer phone is required for auto-recharge. Add it in Company profile.');
    }
    const email = params.email.trim();
    const contact = params.contact.replace(/\D/g, '').slice(-10);

    const response = await this.call(() =>
      this.client.payments.createRecurringPayment({
        amount: params.amountPaise,
        currency: 'INR',
        order_id: params.orderId,
        customer_id: params.customerId,
        token: params.tokenId,
        recurring: true,
        email,
        contact,
        ...(params.description ? { description: params.description } : {}),
      })
    );

    const paymentId = response.razorpay_payment_id;
    if (!paymentId) {
      throw new Error('Razorpay did not return a payment id for recurring charge.');
    }

    return this.fetchPayment(paymentId);
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
