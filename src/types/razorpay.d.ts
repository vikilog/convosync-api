declare module 'razorpay' {
  import type { IncomingMessage } from 'node:http';

  export interface RazorpayOrder {
    id: string;
    entity: string;
    amount: number;
    amount_paid: number;
    amount_due: number;
    currency: string;
    receipt: string;
    status: string;
    notes?: Record<string, string>;
  }

  export interface RazorpayPayment {
    id: string;
    entity: string;
    amount: number;
    currency: string;
    status: string;
    order_id?: string;
    invoice_id?: string;
    method?: string;
    email?: string;
    contact?: string;
    notes?: Record<string, string>;
  }

  export interface RazorpaySubscription {
    id: string;
    entity: string;
    plan_id: string;
    customer_id?: string;
    status: string;
    current_start?: number;
    current_end?: number;
    charge_at?: number;
    notes?: Record<string, string>;
  }

  export interface RazorpayRefund {
    id: string;
    entity: string;
    amount: number;
    currency: string;
    payment_id: string;
    status: string;
  }

  export interface RazorpayPlan {
    id: string;
    entity: string;
    period: string;
    interval: number;
    item?: {
      name?: string;
      amount?: number;
      currency?: string;
    };
  }

  export default class Razorpay {
    constructor(options: { key_id: string; key_secret: string });
    orders: {
      create(params: Record<string, unknown>): Promise<RazorpayOrder>;
      fetch(orderId: string): Promise<RazorpayOrder>;
    };
    payments: {
      fetch(paymentId: string): Promise<RazorpayPayment>;
      refund(paymentId: string, params?: Record<string, unknown>): Promise<RazorpayRefund>;
    };
    subscriptions: {
      create(params: Record<string, unknown>): Promise<RazorpaySubscription>;
      fetch(subscriptionId: string): Promise<RazorpaySubscription>;
      cancel(subscriptionId: string, params?: Record<string, unknown>): Promise<RazorpaySubscription>;
      pause(subscriptionId: string, params?: Record<string, unknown>): Promise<RazorpaySubscription>;
      resume(subscriptionId: string, params?: Record<string, unknown>): Promise<RazorpaySubscription>;
    };
    plans: {
      all(params?: { count?: number; skip?: number }): Promise<{ items: RazorpayPlan[] }>;
      fetch(planId: string): Promise<RazorpayPlan>;
    };
  }
}
