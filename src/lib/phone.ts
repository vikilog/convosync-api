/** Meta WhatsApp `to` field: digits only, no + or spaces. */
export function normalizeWhatsAppRecipient(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    throw new Error('Contact phone number is missing or invalid');
  }
  return digits;
}
