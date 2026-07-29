/** Resolve Contact.phone for a lead — prefer real phone, else stable ig:lead:{id}. */
export function phoneForLeadContact(lead: {
  id: string;
  phone: string | null;
}): string {
  const real = lead.phone?.trim();
  if (real && real.length >= 5) return real;
  return `ig:lead:${lead.id}`;
}
