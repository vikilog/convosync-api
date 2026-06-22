/**
 * Future integration entry points (not wired yet).
 *
 * - Journey node: SEND_EMAIL → call getEmailService().sendTemplate(...)
 * - AI action: send_email → call getEmailService().sendEmail(...)
 * - Email campaigns → call getEmailService().sendBulk(...)
 * - Shared inbox → inbound webhook handler (separate provider callback)
 */
export { getEmailService, getEmailProviderConfigService } from '../container.js';
