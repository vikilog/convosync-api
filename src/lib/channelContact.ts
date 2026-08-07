export function formatInstagramContactPhone(instagramScopedUserId: string): string {
  return `ig:${instagramScopedUserId}`;
}

export function parseInstagramScopedUserId(phone: string): string | null {
  if (!phone.startsWith('ig:')) return null;
  const id = phone.slice(3).trim();
  return id || null;
}

export function isInstagramPhone(phone: string): boolean {
  return phone.startsWith('ig:');
}

export function isInstagramSource(source: string | null | undefined): boolean {
  return source === 'Instagram';
}

/** Strip accidental fb:/ig: before composing the canonical Messenger phone. */
export function normalizeMessengerPsid(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('fb:') || trimmed.startsWith('ig:')) {
    return trimmed.slice(3).trim();
  }
  return trimmed;
}

export function formatMessengerContactPhone(psid: string): string {
  return `fb:${normalizeMessengerPsid(psid)}`;
}

export function parseMessengerPsid(phone: string): string | null {
  if (phone.startsWith('fb:')) {
    const id = phone.slice(3).trim();
    return id || null;
  }
  // Legacy Messenger contacts stored the raw PSID with no fb: prefix.
  // Only accept long digit strings so real WhatsApp numbers stay untouched
  // when this helper is used on Messenger-channel send paths.
  const bare = phone.trim();
  if (/^\d{15,}$/.test(bare)) return bare;
  return null;
}

export function isMessengerPhone(phone: string): boolean {
  return phone.startsWith('fb:');
}

export function isMessengerSource(source: string | null | undefined): boolean {
  return source === 'Messenger';
}

export type ContactChannelFilter = 'whatsapp' | 'instagram' | 'messenger';

/** Channel implied by how the contact's `phone` identity column is encoded. */
export function resolveContactChannel(contact: { phone: string }): ContactChannelFilter {
  if (isInstagramPhone(contact.phone)) return 'instagram';
  if (isMessengerPhone(contact.phone)) return 'messenger';
  return 'whatsapp';
}

export function contactChannelWhere(channel: ContactChannelFilter): {
  OR?: Array<{ phone?: { startsWith: string }; source?: string }>;
  AND?: Array<{ NOT: { phone: { startsWith: string } } }>;
} {
  switch (channel) {
    case 'instagram':
      return {
        OR: [{ phone: { startsWith: 'ig:' } }, { source: 'Instagram' }],
      };
    case 'messenger':
      return {
        OR: [{ phone: { startsWith: 'fb:' } }, { source: 'Messenger' }],
      };
    case 'whatsapp':
      return {
        AND: [
          { NOT: { phone: { startsWith: 'ig:' } } },
          { NOT: { phone: { startsWith: 'fb:' } } },
        ],
      };
  }
}
