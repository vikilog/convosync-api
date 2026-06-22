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

export function formatMessengerContactPhone(psid: string): string {
  return `fb:${psid}`;
}

export function parseMessengerPsid(phone: string): string | null {
  if (!phone.startsWith('fb:')) return null;
  const id = phone.slice(3).trim();
  return id || null;
}

export function isMessengerPhone(phone: string): boolean {
  return phone.startsWith('fb:');
}

export function isMessengerSource(source: string | null | undefined): boolean {
  return source === 'Messenger';
}

export type ContactChannelFilter = 'whatsapp' | 'instagram' | 'messenger';

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
