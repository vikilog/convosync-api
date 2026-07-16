export type BillingCycle = 'monthly' | 'annual';

export type AddOnType =
  | 'contacts'
  | 'team_members'
  | 'ai_agents'
  | 'channels'
  | 'ai_tokens'
  | 'campaigns'
  | 'emails';

export type AddonCatalogEntry = {
  type: AddOnType;
  label: string;
  unitLabel: string;
  unitPaise: number;
  usdPerUnit: number;
  description: string;
  minQuantity: number;
  maxQuantity: number;
};

/** INR paise pricing aligned to ~₹83/$ (see custom plan checkout). */
export const ADDON_CATALOG: AddonCatalogEntry[] = [
  {
    type: 'emails',
    label: 'Email sends',
    unitLabel: '1,000 emails',
    unitPaise: 8300,
    usdPerUnit: 1,
    description: 'Platform email via AWS SES · $1 per 1,000 sends',
    minQuantity: 1,
    maxQuantity: 100,
  },
  {
    type: 'contacts',
    label: 'Contacts',
    unitLabel: '1,000 contacts',
    unitPaise: 30000,
    usdPerUnit: 3,
    description: 'Extra contact storage',
    minQuantity: 1,
    maxQuantity: 50,
  },
  {
    type: 'team_members',
    label: 'Team seats',
    unitLabel: 'seat',
    unitPaise: 10000,
    usdPerUnit: 1,
    description: 'Additional team member',
    minQuantity: 1,
    maxQuantity: 50,
  },
  {
    type: 'ai_agents',
    label: 'AI agents',
    unitLabel: 'agent',
    unitPaise: 50000,
    usdPerUnit: 5,
    description: 'Additional AI agent',
    minQuantity: 1,
    maxQuantity: 20,
  },
  {
    type: 'channels',
    label: 'Channels',
    unitLabel: 'channel',
    unitPaise: 20000,
    usdPerUnit: 2,
    description: 'Additional messaging channel',
    minQuantity: 1,
    maxQuantity: 20,
  },
  {
    type: 'ai_tokens',
    label: 'AI tokens',
    unitLabel: '10,000 tokens',
    unitPaise: 100,
    usdPerUnit: 0.01,
    description: 'Extra AI reply capacity',
    minQuantity: 1,
    maxQuantity: 500,
  },
  {
    type: 'campaigns',
    label: 'Campaigns',
    unitLabel: 'campaign',
    unitPaise: 15000,
    usdPerUnit: 1.5,
    description: 'Additional active campaigns',
    minQuantity: 1,
    maxQuantity: 50,
  },
];

export type OrderPurpose =
  | 'addon'
  | 'custom_plan'
  | 'plan_purchase'
  | 'one_time'
  | 'wallet_topup'
  | 'wallet_auto_recharge_setup'
  | 'wallet_auto_recharge';

export interface CreateOrderBody {
  amountPaise?: number;
  /** ConvoCoins credited to wallet (base amount before GST/fees). */
  creditAmountPaise?: number;
  purpose?: OrderPurpose;
  addonType?: AddOnType;
  quantity?: number;
  description?: string;
}

export interface VerifyOrderBody {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface CreateSubscriptionBody {
  planId: string;
  billingCycle?: BillingCycle;
}

export interface VerifySubscriptionBody {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

export interface CancelSubscriptionBody {
  cancelAtPeriodEnd?: boolean;
}

export interface RefundBody {
  paymentId: string;
  amountPaise?: number;
  reason?: string;
}

export interface BillingPlanResponse {
  id: string;
  slug: string;
  name: string;
  priceMonthlyPaise: number | null;
  priceAnnualPaise: number | null;
  razorpayPlanIdMonthly: string | null;
  razorpayPlanIdAnnual: string | null;
  features: unknown;
}
