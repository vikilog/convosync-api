/**
 * ponytail: shouldMeterUsage matrix (pure helpers mirrored for assert).
 * Run: npx tsx src/services/shouldMeterUsage.check.ts
 */
import assert from 'node:assert/strict';
import { usesPlatformEmailMetering } from '../modules/email/types/provider-config.types.ts';
import { normalizeAiProviderMode } from '../modules/ai-agent/types/ai-provider.types.ts';

/** Mirrors shouldMeterEmail: platform default meters; BYO default / active SES config skips. */
function meterEmailFromState(opts: {
  defaultProvider?: string | null;
  hasActiveSesConfig?: boolean;
}): boolean {
  if (opts.defaultProvider && !usesPlatformEmailMetering(opts.defaultProvider)) {
    return false;
  }
  if (opts.hasActiveSesConfig) return false;
  return true;
}

/** Mirrors shouldMeterWhatsApp decision from paymentMode. */
function meterWhatsAppFromPaymentMode(paymentMode: string | null | undefined): boolean {
  return paymentMode === 'platform';
}

/** Mirrors shouldMeterAi decision from mode + status. */
function meterAiFromConfig(
  mode: string | null | undefined,
  status: string | null | undefined
): boolean {
  if (!mode) return true;
  if (normalizeAiProviderMode(mode) === 'byok' && status !== 'credentials_missing') {
    return false;
  }
  return true;
}

// Email
assert.equal(meterEmailFromState({ defaultProvider: 'CONVOSYNC_MANAGED' }), true);
assert.equal(meterEmailFromState({ defaultProvider: 'WABIZ_MANAGED' }), true);
assert.equal(meterEmailFromState({ defaultProvider: 'AWS_SES' }), false);
assert.equal(meterEmailFromState({ defaultProvider: 'RESEND' }), false);
assert.equal(meterEmailFromState({ defaultProvider: 'SENDGRID' }), false);
assert.equal(meterEmailFromState({ defaultProvider: 'SMTP' }), false);
assert.equal(meterEmailFromState({}), true);
// Stale default=platform but WorkspaceEmailConfig still active → skip
assert.equal(
  meterEmailFromState({
    defaultProvider: 'CONVOSYNC_MANAGED',
    hasActiveSesConfig: true,
  }),
  false
);
// Platform default + SES config disabled → meter
assert.equal(
  meterEmailFromState({
    defaultProvider: 'CONVOSYNC_MANAGED',
    hasActiveSesConfig: false,
  }),
  true
);

// WhatsApp — only platform mode meters
assert.equal(meterWhatsAppFromPaymentMode('platform'), true);
assert.equal(meterWhatsAppFromPaymentMode('self_pay'), false);
assert.equal(meterWhatsAppFromPaymentMode(null), false);
assert.equal(meterWhatsAppFromPaymentMode(undefined), false);

// AI — BYOK with credentials skips; missing key still meters (falls back to platform)
assert.equal(meterAiFromConfig('byok', 'active'), false);
assert.equal(meterAiFromConfig('byok', 'connection_failed'), false);
assert.equal(meterAiFromConfig('byok', 'credentials_missing'), true);
assert.equal(meterAiFromConfig('convosync', 'active'), true);
assert.equal(meterAiFromConfig('wabiz', 'active'), true);
assert.equal(meterAiFromConfig(null, null), true);

console.log('shouldMeterUsage.check: ok');
