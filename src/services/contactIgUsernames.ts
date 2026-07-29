import type { ContactChannelFilter } from '../lib/channelContact.js';

export function normalizeIgUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!u || /^\d+$/.test(u) || u.startsWith('lead:')) return null;
  return u;
}

/** Collect Instagram handles from linked channels + journey origin. */
export function igUsernamesForContactGroup(input: {
  channels: Array<{ channel: ContactChannelFilter; name: string; phone: string }>;
  journeyUsername?: string | null;
}): string[] {
  const out = new Set<string>();
  for (const c of input.channels) {
    if (c.channel !== 'instagram') continue;
    const fromName = normalizeIgUsername(c.name);
    if (fromName) out.add(fromName);
    const fromPhone = normalizeIgUsername(c.phone.replace(/^ig:/i, ''));
    if (fromPhone) out.add(fromPhone);
  }
  const fromJourney = normalizeIgUsername(input.journeyUsername);
  if (fromJourney) out.add(fromJourney);
  return [...out];
}
