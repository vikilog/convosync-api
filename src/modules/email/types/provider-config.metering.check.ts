/**
 * Platform email metering matrix:
 *   CONVOSYNC_MANAGED (legacy WABIZ_MANAGED) → wallet CC only (no emailsLimit)
 *   AWS_SES / RESEND / SENDGRID / SMTP (BYOP) → no platform metering
 *
 * Run: npx tsx src/modules/email/types/provider-config.metering.check.ts
 */
import assert from 'node:assert/strict';
import { usesPlatformEmailMetering } from './provider-config.types.ts';

assert.equal(usesPlatformEmailMetering('CONVOSYNC_MANAGED'), true);
assert.equal(usesPlatformEmailMetering('WABIZ_MANAGED'), true);
assert.equal(usesPlatformEmailMetering('AWS_SES'), false);
assert.equal(usesPlatformEmailMetering('RESEND'), false);
assert.equal(usesPlatformEmailMetering('SENDGRID'), false);
assert.equal(usesPlatformEmailMetering('SMTP'), false);

// Behavior contract (enforced in EmailService.sendEmail, not here):
// platform meter=true  → assertEmailSendAffordable + chargeEmailSendUsage; never emailsLimit
// BYOP     meter=false → skip affordability + charge
console.log('provider-config.metering.check.ts: ok (platform=CC only, BYOP=unmetered)');
