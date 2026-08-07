/** Pure helpers for SES ListIdentities / GetIdentityVerificationAttributes results. */

export type SesVerifiedIdentity = {
  identity: string;
  type: 'email' | 'domain';
};

export function identityType(identity: string): 'email' | 'domain' {
  return identity.includes('@') ? 'email' : 'domain';
}

/** SES attribute maps are usually exact-key; fall back to case-insensitive match. */
export function verificationStatusOf(
  identity: string,
  attributes: Record<string, { VerificationStatus?: string } | undefined>
): string | undefined {
  const direct = attributes[identity]?.VerificationStatus;
  if (direct) return direct;
  const lower = identity.toLowerCase();
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === lower) return value?.VerificationStatus;
  }
  return undefined;
}

/**
 * Keep only identities with VerificationStatus === Success.
 * Domains first (Domain section UI), then emails; alpha within each type.
 */
export function filterVerifiedIdentities(
  identities: string[],
  attributes: Record<string, { VerificationStatus?: string } | undefined>
): SesVerifiedIdentity[] {
  const out: SesVerifiedIdentity[] = [];
  for (const raw of identities) {
    const identity = raw.trim();
    if (!identity) continue;
    if (verificationStatusOf(identity, attributes) !== 'Success') continue;
    out.push({ identity, type: identityType(identity) });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'domain' ? -1 : 1;
    return a.identity.localeCompare(b.identity);
  });
  return out;
}

/** Dedupe identity names from ListIdentities pages (preserves first-seen order). */
export function mergeIdentityNames(...pages: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const page of pages) {
    for (const raw of page ?? []) {
      const identity = raw.trim();
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      out.push(identity);
    }
  }
  return out;
}

export function parseCachedVerifiedIdentities(value: unknown): SesVerifiedIdentity[] {
  if (!Array.isArray(value)) return [];
  const out: SesVerifiedIdentity[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const identity = typeof (item as { identity?: unknown }).identity === 'string'
      ? (item as { identity: string }).identity.trim()
      : '';
    if (!identity) continue;
    const typeRaw = (item as { type?: unknown }).type;
    const type =
      typeRaw === 'email' || typeRaw === 'domain' ? typeRaw : identityType(identity);
    out.push({ identity, type });
  }
  return out;
}

/** True when fromEmail is a verified email identity, or under a verified domain. */
export function isSenderAllowedByIdentities(
  fromEmail: string,
  identities: SesVerifiedIdentity[]
): boolean {
  const from = fromEmail.trim().toLowerCase();
  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) return false;
  const domain = from.split('@')[1] ?? '';
  for (const id of identities) {
    const name = id.identity.trim().toLowerCase();
    if (id.type === 'email' && name === from) return true;
    if (id.type === 'domain' && name === domain) return true;
  }
  return false;
}

export function sesVerifiedIdentitiesConsoleUrl(region: string): string {
  const r = region.trim() || 'us-east-1';
  return `https://${r}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(r)}#/verified-identities`;
}
