/**
 * BYO / self-pay gate for ConvoCoins metering.
 * false → skip wallet debit (client pays the provider directly).
 */
import { prisma } from '../lib/prisma.js';
import { usesPlatformEmailMetering } from '../modules/email/types/provider-config.types.js';
import { normalizeAiProviderMode } from '../modules/ai-agent/types/ai-provider.types.js';

export type MeterResourceType = 'email' | 'whatsapp' | 'ai';

export type ShouldMeterUsageOpts = {
  /** WhatsApp phone_number_id for the send; when omitted, uses workspace default account. */
  phoneNumberId?: string | null;
};

/** Meter only when ConvoSync covers the underlying provider cost. */
export async function shouldMeterUsage(
  workspaceId: string,
  resourceType: MeterResourceType,
  opts?: ShouldMeterUsageOpts
): Promise<boolean> {
  if (resourceType === 'email') return shouldMeterEmail(workspaceId);
  if (resourceType === 'whatsapp') return shouldMeterWhatsApp(workspaceId, opts?.phoneNumberId);
  return shouldMeterAi(workspaceId);
}

async function shouldMeterEmail(workspaceId: string): Promise<boolean> {
  const defaultProvider = await prisma.emailProviderConfig.findFirst({
    where: { workspaceId, isDefault: true },
    select: { provider: true },
  });
  if (defaultProvider && !usesPlatformEmailMetering(defaultProvider.provider)) {
    return false;
  }
  // Belt: WorkspaceEmailConfig isActive only while SES is the Providers-tab default
  // (cleared when platform is set default). Covers a brief stale-isDefault window.
  const sesCfg = await prisma.workspaceEmailConfig.findUnique({
    where: { workspaceId },
    select: { isActive: true, provider: true },
  });
  if (sesCfg?.isActive && sesCfg.provider === 'ses') return false;

  return true;
}

/**
 * ConvoCoins only when paymentMode is platform (ConvoSync covers Meta).
 * self_pay / null → client (or Meta) bills; skip wallet debit.
 */
async function shouldMeterWhatsApp(
  workspaceId: string,
  phoneNumberId?: string | null
): Promise<boolean> {
  const account = phoneNumberId
    ? await prisma.whatsAppPhoneAccount.findFirst({
        where: { workspaceId, phoneNumberId },
        select: { paymentMode: true },
      })
    : await prisma.whatsAppPhoneAccount.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
        select: { paymentMode: true },
      });

  if (!account) return true;
  return account.paymentMode === 'platform';
}

async function shouldMeterAi(workspaceId: string): Promise<boolean> {
  const row = await prisma.workspaceAiProviderConfig.findUnique({
    where: { workspaceId },
    select: { mode: true, status: true },
  });
  if (!row) return true;
  // BYOK with a configured key: client pays OpenAI/Anthropic directly.
  if (normalizeAiProviderMode(row.mode) === 'byok' && row.status !== 'credentials_missing') {
    return false;
  }
  return true;
}
