import axios from 'axios';
import { prisma } from '../lib/prisma.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import {
  billingCheckUnknownNote,
  buildMetaPaymentSetupUrl,
  extractMetaErrorCode,
  formatMetaBillingProbeError,
  isBillingProbePermissionError,
  parseHasOwnMetaPaymentMethod,
  type BillingCheckStatus,
} from './whatsappPaymentConfig.parse.js';

export {
  buildMetaPaymentSetupUrl,
  parseHasOwnMetaPaymentMethod,
  type BillingCheckStatus,
};

const GRAPH_VERSION = 'v21.0';

export type PaymentMode = 'self_pay' | 'platform';

export type WhatsAppPaymentStatus = {
  phoneNumberId: string;
  wabaId: string;
  paymentMode: PaymentMode | null;
  hasOwnMetaPaymentMethod: boolean;
  /** confirmed = Meta funding seen; missing = probe ok, no card; unknown = TP/#10 etc. */
  billingCheckStatus: BillingCheckStatus;
  paymentConfigCheckedAt: string | null;
  paymentSetupAcknowledgedAt: string | null;
  metaBusinessId: string | null;
  /** Meta Business Manager payment methods URL (scoped when business id known). */
  metaPaymentSetupUrl: string;
  primaryFundingId?: string | null;
  /** Soft guidance (e.g. unknown check) — not a hard failure. */
  note?: string;
  /** Real probe failures only (token/network); permission/#10 uses note instead. */
  error?: string;
};

function extractBusinessId(ownerBusinessInfo: unknown): string | null {
  if (!ownerBusinessInfo || typeof ownerBusinessInfo !== 'object') return null;
  const id = (ownerBusinessInfo as { id?: unknown }).id;
  return typeof id === 'string' && /^\d+$/.test(id) ? id : null;
}

type MetaPaymentProbe = {
  hasOwnMetaPaymentMethod: boolean;
  billingCheckStatus: BillingCheckStatus;
  primaryFundingId: string | null;
  metaBusinessId: string | null;
  note?: string;
  error?: string;
};

async function graphGet(
  path: string,
  accessToken: string,
  fields: string
): Promise<{ status: number; data: unknown }> {
  const res = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` },
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

/**
 * Detect Self Pay messaging billing via WABA `primary_funding_id`.
 * Do not call `/{waba}/payment_configuration` — that is Payments-in commerce and
 * requires `configuration_name`.
 *
 * Split fields: `primary_funding_id` is BSP-gated (#10 for Tech Providers). Fetch
 * `owner_business_info` separately so BM payment URL still works.
 */
async function probeMetaBillingPaymentMethod(
  wabaId: string,
  accessToken: string
): Promise<MetaPaymentProbe> {
  let primaryFundingId: string | null = null;
  let metaBusinessId: string | null = null;
  let note: string | undefined;
  let error: string | undefined;
  let billingCheckStatus: BillingCheckStatus = 'missing';

  try {
    const ownerRes = await graphGet(wabaId, accessToken, 'owner_business_info');
    if (ownerRes.status >= 200 && ownerRes.status < 300) {
      metaBusinessId = extractBusinessId(
        (ownerRes.data as { owner_business_info?: unknown })?.owner_business_info
      );
    }
    // ponytail: owner_business_info failure is non-fatal; BM URL falls back to unscoped.

    const fundingRes = await graphGet(wabaId, accessToken, 'primary_funding_id');
    if (fundingRes.status >= 200 && fundingRes.status < 300) {
      const funding = (fundingRes.data as { primary_funding_id?: unknown })?.primary_funding_id;
      if (funding != null && String(funding).trim()) {
        primaryFundingId = String(funding);
      }
      billingCheckStatus = parseHasOwnMetaPaymentMethod({ primaryFundingId })
        ? 'confirmed'
        : 'missing';
    } else {
      const code = extractMetaErrorCode(fundingRes.data);
      if (isBillingProbePermissionError(code)) {
        // Tech Provider / non-BSP: cannot auto-detect; Self Pay still valid.
        billingCheckStatus = 'unknown';
        note = billingCheckUnknownNote();
      } else {
        billingCheckStatus = 'unknown';
        error = formatMetaBillingProbeError(
          fundingRes.data,
          `Meta could not check billing payment method (HTTP ${fundingRes.status}).`
        );
      }
    }
  } catch (err) {
    billingCheckStatus = 'unknown';
    error = err instanceof Error ? err.message : 'Meta billing payment method request failed';
  }

  const hasOwnMetaPaymentMethod = parseHasOwnMetaPaymentMethod({ primaryFundingId });

  return {
    hasOwnMetaPaymentMethod,
    billingCheckStatus: hasOwnMetaPaymentMethod ? 'confirmed' : billingCheckStatus,
    primaryFundingId,
    metaBusinessId,
    note: hasOwnMetaPaymentMethod ? undefined : note,
    error: hasOwnMetaPaymentMethod ? undefined : error,
  };
}

function parseBillingCheckStatus(
  raw: string | null | undefined,
  hasOwnMetaPaymentMethod: boolean
): BillingCheckStatus {
  if (hasOwnMetaPaymentMethod) return 'confirmed';
  if (raw === 'confirmed' || raw === 'missing' || raw === 'unknown') return raw;
  return 'missing';
}

function toStatus(
  account: {
    phoneNumberId: string;
    wabaId: string;
    paymentMode: string | null;
    hasOwnMetaPaymentMethod: boolean;
    billingCheckStatus: string | null;
    paymentConfigCheckedAt: Date | null;
    paymentSetupAcknowledgedAt: Date | null;
    metaBusinessId: string | null;
  },
  extras?: {
    primaryFundingId?: string | null;
    note?: string;
    error?: string;
    billingCheckStatus?: BillingCheckStatus;
  }
): WhatsAppPaymentStatus {
  const mode =
    account.paymentMode === 'self_pay' || account.paymentMode === 'platform'
      ? account.paymentMode
      : null;
  const billingCheckStatus =
    extras?.billingCheckStatus ??
    parseBillingCheckStatus(account.billingCheckStatus, account.hasOwnMetaPaymentMethod);
  return {
    phoneNumberId: account.phoneNumberId,
    wabaId: account.wabaId,
    paymentMode: mode,
    hasOwnMetaPaymentMethod: account.hasOwnMetaPaymentMethod,
    billingCheckStatus,
    paymentConfigCheckedAt: account.paymentConfigCheckedAt?.toISOString() ?? null,
    paymentSetupAcknowledgedAt: account.paymentSetupAcknowledgedAt?.toISOString() ?? null,
    metaBusinessId: account.metaBusinessId,
    metaPaymentSetupUrl: buildMetaPaymentSetupUrl(account.metaBusinessId),
    primaryFundingId: extras?.primaryFundingId,
    note:
      extras?.note ??
      (billingCheckStatus === 'unknown' && !account.hasOwnMetaPaymentMethod
        ? billingCheckUnknownNote()
        : undefined),
    error: extras?.error,
  };
}

async function resolveAccount(workspaceId: string, phoneNumberId?: string) {
  if (phoneNumberId?.trim()) {
    return prisma.whatsAppPhoneAccount.findFirst({
      where: { workspaceId, phoneNumberId: phoneNumberId.trim() },
    });
  }
  return prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getWhatsAppPaymentStatus(
  workspaceId: string,
  phoneNumberId?: string
): Promise<WhatsAppPaymentStatus> {
  const account = await resolveAccount(workspaceId, phoneNumberId);
  if (!account) {
    throw new Error('WhatsApp is not connected for this company.');
  }
  return toStatus(account);
}

/**
 * Re-check WABA primary_funding_id (messaging billing) and persist on the phone account.
 */
export async function refreshWhatsAppPaymentConfiguration(
  workspaceId: string,
  phoneNumberId?: string,
  opts?: { businessIdHint?: string | null }
): Promise<WhatsAppPaymentStatus> {
  const account = await resolveAccount(workspaceId, phoneNumberId);
  if (!account) {
    throw new Error('WhatsApp is not connected for this company.');
  }

  const { accessToken, wabaId } = await getWorkspaceWhatsAppCredentials(
    workspaceId,
    account.phoneNumberId
  );

  const probe = await probeMetaBillingPaymentMethod(wabaId, accessToken);
  const metaBusinessId =
    opts?.businessIdHint?.trim() ||
    probe.metaBusinessId ||
    account.metaBusinessId ||
    null;

  const updated = await prisma.whatsAppPhoneAccount.update({
    where: { id: account.id },
    data: {
      hasOwnMetaPaymentMethod: probe.hasOwnMetaPaymentMethod,
      billingCheckStatus: probe.billingCheckStatus,
      paymentConfigCheckedAt: new Date(),
      // Meta confirmed funding — clear stale user ack
      ...(probe.hasOwnMetaPaymentMethod ? { paymentSetupAcknowledgedAt: null } : {}),
      ...(metaBusinessId ? { metaBusinessId } : {}),
    },
  });

  return toStatus(updated, {
    primaryFundingId: probe.primaryFundingId,
    note: probe.note,
    error: probe.error,
    billingCheckStatus: probe.billingCheckStatus,
  });
}

/** Persist payment mode. Only `self_pay` is accepted for now (platform is Coming soon). */
export async function setWhatsAppPaymentMode(
  workspaceId: string,
  paymentMode: PaymentMode,
  phoneNumberId?: string,
  opts?: { businessIdHint?: string | null }
): Promise<WhatsAppPaymentStatus> {
  if (paymentMode !== 'self_pay') {
    throw new Error('Platform billing is coming soon. Choose Self Pay for now.');
  }

  const account = await resolveAccount(workspaceId, phoneNumberId);
  if (!account) {
    throw new Error('WhatsApp is not connected for this company.');
  }

  await prisma.whatsAppPhoneAccount.update({
    where: { id: account.id },
    data: {
      paymentMode: 'self_pay',
      ...(opts?.businessIdHint?.trim()
        ? { metaBusinessId: opts.businessIdHint.trim() }
        : {}),
    },
  });

  return refreshWhatsAppPaymentConfiguration(workspaceId, account.phoneNumberId, opts);
}

/**
 * User confirms they added a Meta payment method when auto-check is unknown (#10 / TP).
 * Does NOT set hasOwnMetaPaymentMethod — that stays Meta-truth only.
 */
export async function acknowledgeWhatsAppPaymentSetup(
  workspaceId: string,
  phoneNumberId?: string
): Promise<WhatsAppPaymentStatus> {
  const account = await resolveAccount(workspaceId, phoneNumberId);
  if (!account) {
    throw new Error('WhatsApp is not connected for this company.');
  }

  const updated = await prisma.whatsAppPhoneAccount.update({
    where: { id: account.id },
    data: {
      paymentSetupAcknowledgedAt: new Date(),
      // Ensure Self Pay is selected if they acknowledge from the panel
      ...(account.paymentMode ? {} : { paymentMode: 'self_pay' }),
    },
  });

  return toStatus(updated);
}
