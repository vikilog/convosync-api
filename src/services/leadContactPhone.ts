import { normalizeWhatsAppContactPhone } from '../lib/whatsappContact.js';

/**
 * Resolve Contact.phone for a lead — prefer real phone, else stable
 * ig:lead:{id}. Normalized the same way inbound WhatsApp contacts are
 * (digits only) so convertLeadToContact's exact-match lookup actually finds
 * an existing WhatsApp-sourced Contact instead of creating a duplicate.
 */
export function phoneForLeadContact(lead: {
  id: string;
  phone: string | null;
}): string {
  const real = lead.phone?.trim();
  if (real && real.length >= 5) {
    const digits = normalizeWhatsAppContactPhone(real);
    return digits.length >= 5 ? digits : real;
  }
  return `ig:lead:${lead.id}`;
}
