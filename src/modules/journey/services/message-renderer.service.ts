import type { Contact } from '@prisma/client';

const CONTACT_FIELD_MAP: Record<string, (c: Contact) => unknown> = {
  'contact.name': (c) => c.name,
  'contact.phone': (c) => c.phone,
  'contact.email': (c) => c.email ?? '',
  name: (c) => c.name,
  phone: (c) => c.phone,
  email: (c) => c.email ?? '',
  journeyStatus: (c) => c.journeyStatus ?? '',
};

function readCustomField(contact: Contact, key: string): unknown {
  const fields = contact.customFields as Record<string, unknown> | null;
  if (!fields) return undefined;
  return fields[key];
}

export function resolveContactField(contact: Contact, field: string): unknown {
  const resolver = CONTACT_FIELD_MAP[field];
  if (resolver) return resolver(contact);
  if (field.startsWith('contact.')) {
    const sub = field.slice('contact.'.length);
    if (sub === 'name' || sub === 'phone' || sub === 'email') {
      return CONTACT_FIELD_MAP[`contact.${sub}`](contact);
    }
    return readCustomField(contact, sub);
  }
  if (field.startsWith('custom.')) {
    return readCustomField(contact, field.slice('custom.'.length));
  }
  return readCustomField(contact, field);
}

export function renderTemplateVariables(
  template: string,
  contact: Contact,
  extra?: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, key: string) => {
    const trimmed = key.trim();
    if (trimmed.startsWith('contact.')) {
      const val = resolveContactField(contact, trimmed);
      return val == null ? '' : String(val);
    }
    if (extra && trimmed in extra) {
      return String(extra[trimmed] ?? '');
    }
    const fromContact = resolveContactField(contact, trimmed);
    return fromContact == null ? '' : String(fromContact);
  });
}

export function mapVariableRecord(
  variables: Record<string, string> | undefined,
  contact: Contact
): string[] {
  if (!variables) return [];
  return Object.values(variables).map((v) => renderTemplateVariables(v, contact));
}

export function resolveSendMessageVariables(
  variables: Record<string, string> | string[] | undefined,
  contact: Contact
): string[] {
  if (Array.isArray(variables)) {
    return variables.map((v) => renderTemplateVariables(String(v), contact));
  }
  return mapVariableRecord(variables, contact);
}
