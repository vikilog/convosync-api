import axios from 'axios';
import { config } from '../config.js';

const GRAPH_VERSION = 'v21.0';

export type CreditLineShareResult = {
  attempted: boolean;
  shared: boolean;
  skipped?: boolean;
  alreadyShared?: boolean;
  allocationConfigId?: string;
  wabaId?: string;
  error?: string;
  details?: string;
};

/** Supported Meta WABA credit-share currencies (ISO 4217). */
const SUPPORTED_CURRENCIES = new Set(['AUD', 'EUR', 'GBP', 'IDR', 'INR', 'USD']);

export function normalizeWabaCurrency(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(code)) {
    throw new Error(
      `Unsupported waba_currency "${currency}". Use one of: ${[...SUPPORTED_CURRENCIES].join(', ')}`
    );
  }
  return code;
}

/**
 * Build Graph URL for Solution Partner credit-line share+attach.
 * Docs: POST /{EXTENDED_CREDIT_LINE_ID}/whatsapp_credit_sharing_and_attach
 */
export function buildCreditSharingAndAttachUrl(params: {
  creditLineId: string;
  wabaId: string;
  wabaCurrency: string;
  graphVersion?: string;
}): string {
  const creditLineId = params.creditLineId.trim();
  const wabaId = params.wabaId.trim();
  if (!/^\d+$/.test(creditLineId)) {
    throw new Error('creditLineId must be a numeric Meta extended credit line id');
  }
  if (!/^\d+$/.test(wabaId)) {
    throw new Error('wabaId must be a numeric WhatsApp Business Account id');
  }
  const currency = normalizeWabaCurrency(params.wabaCurrency);
  const version = params.graphVersion || GRAPH_VERSION;
  const qs = new URLSearchParams({
    waba_currency: currency,
    waba_id: wabaId,
  });
  return `https://graph.facebook.com/${version}/${creditLineId}/whatsapp_credit_sharing_and_attach?${qs}`;
}

function formatMetaApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as {
      error?: { message?: string; error_user_msg?: string; code?: number };
    };
    return data?.error?.error_user_msg || data?.error?.message || err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Meta API request failed';
}

function isAlreadySharedError(err: unknown): boolean {
  const msg = formatMetaApiError(err).toLowerCase();
  return (
    msg.includes('already shared') ||
    msg.includes('already been shared') ||
    msg.includes('has been shared') ||
    msg.includes('already attached') ||
    msg.includes('duplicate')
  );
}

function creditLineConfig(): {
  creditLineId: string;
  systemToken: string;
  wabaCurrency: string;
} | null {
  const creditLineId = config.meta.creditLineId;
  const systemToken = config.meta.systemUserToken;
  if (!creditLineId || !systemToken) return null;
  return {
    creditLineId,
    systemToken,
    wabaCurrency: config.meta.creditLineCurrency,
  };
}

/**
 * Share ConvoSync's Meta extended credit line with a client WABA (Solution Partner OBO billing).
 * No-ops when META_CREDIT_LINE_ID / system token env are unset.
 * Does not throw — connect should still succeed; log + return error for ops.
 */
export async function shareCreditLineWithWaba(wabaId: string): Promise<CreditLineShareResult> {
  const cfg = creditLineConfig();
  if (!cfg) {
    return {
      attempted: false,
      shared: false,
      skipped: true,
      details:
        'META_CREDIT_LINE_ID (or WHATSAPP_EXTENDED_CREDIT_ID) and META_SYSTEM_USER_TOKEN unset — client WABA bills Meta directly unless configured.',
    };
  }

  if (!wabaId?.trim()) {
    return { attempted: false, shared: false, skipped: true, error: 'Missing WABA id' };
  }

  let url: string;
  try {
    url = buildCreditSharingAndAttachUrl({
      creditLineId: cfg.creditLineId,
      wabaId,
      wabaCurrency: cfg.wabaCurrency,
    });
  } catch (err) {
    return {
      attempted: false,
      shared: false,
      error: err instanceof Error ? err.message : 'Invalid credit-line share params',
    };
  }

  try {
    const res = await axios.post(
      url,
      null,
      { headers: { Authorization: `Bearer ${cfg.systemToken}` } }
    );
    const allocationConfigId =
      res.data?.allocation_config_id != null
        ? String(res.data.allocation_config_id)
        : undefined;
    return {
      attempted: true,
      shared: Boolean(allocationConfigId || res.data?.waba_id),
      allocationConfigId,
      wabaId: res.data?.waba_id ? String(res.data.waba_id) : wabaId,
    };
  } catch (err) {
    if (isAlreadySharedError(err)) {
      return {
        attempted: true,
        shared: true,
        alreadyShared: true,
        wabaId,
        details: formatMetaApiError(err),
      };
    }
    return {
      attempted: true,
      shared: false,
      wabaId,
      error: formatMetaApiError(err),
    };
  }
}
