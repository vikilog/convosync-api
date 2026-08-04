function readCustomFieldsRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

function stringField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t || undefined;
}

/** Prefer contact columns; fall back to customFields.name/email/phone. */
export function resolveContactIdentityFields(contact: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  customFields?: unknown;
}): { name?: string; email?: string; phone?: string } {
  const cf = readCustomFieldsRecord(contact.customFields);
  const name = stringField(contact.name) ?? stringField(cf.name);
  const email = stringField(contact.email) ?? stringField(cf.email);
  const phone = stringField(contact.phone) ?? stringField(cf.phone);
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}
