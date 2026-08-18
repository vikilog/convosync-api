import { Prisma, type PrismaClient, type Contact } from '@prisma/client';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isPrismaRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

export type WhatsAppWebhookContact = {
  profile?: { name?: string };
  wa_id?: string;
};

export function normalizeWhatsAppContactPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Collapse +91XXXXXXXXXX vs local 10-digit forms for inbox dedupe —
 * India-specific by design. Deliberately does NOT generically truncate to
 * the last 10 digits of any number: two unrelated contacts from different
 * countries can share the same trailing 10 digits, and a blanket suffix
 * match previously let findWhatsAppContacts/mergeDuplicateWhatsAppContacts
 * silently merge (and delete) an unrelated real customer's contact row.
 */
export function whatsappCanonicalDigits(phone: string): string {
  const digits = normalizeWhatsAppContactPhone(phone);
  if (!digits) return '';
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return digits;
}

/** One inbox row key per WhatsApp phone (wa:last10 or wa:short). */
export function whatsappInboxPhoneKey(phone: string): string | null {
  const canonical = whatsappCanonicalDigits(phone);
  return canonical ? `wa:${canonical}` : null;
}

export function phonesMatch(a: string, b: string): boolean {
  const left = normalizeWhatsAppContactPhone(a);
  const right = normalizeWhatsAppContactPhone(b);
  if (left === right) return true;
  const canonicalLeft = whatsappCanonicalDigits(a);
  const canonicalRight = whatsappCanonicalDigits(b);
  return Boolean(canonicalLeft && canonicalLeft === canonicalRight);
}

export function extractWhatsAppProfileName(
  contacts: WhatsAppWebhookContact[] | undefined,
  waId: string
): string | undefined {
  if (!contacts?.length) return undefined;
  const match =
    contacts.find((c) => c.wa_id === waId || c.wa_id === normalizeWhatsAppContactPhone(waId)) ??
    contacts[0];
  const name = match?.profile?.name?.trim();
  return name || undefined;
}

export function formatWhatsAppDisplayPhone(phone: string): string {
  const digits = normalizeWhatsAppContactPhone(phone);
  if (!digits) return phone;
  return `+${digits}`;
}

export function resolveWhatsAppContactName(profileName: string | undefined, phone: string): string {
  if (profileName?.trim()) return profileName.trim();
  return formatWhatsAppDisplayPhone(phone);
}

export function isPlaceholderWhatsAppContactName(name: string, phone: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const nameDigits = normalizeWhatsAppContactPhone(trimmed);
  const phoneDigits = normalizeWhatsAppContactPhone(phone);
  return nameDigits === phoneDigits;
}

export async function findWhatsAppContacts(
  db: PrismaClient,
  workspaceId: string,
  waFrom: string
): Promise<Contact[]> {
  const digits = normalizeWhatsAppContactPhone(waFrom);
  if (!digits) return [];

  const or: Array<Record<string, unknown>> = [
    { phone: waFrom },
    { phone: digits },
    { phone: `+${digits}` },
  ];

  // India +91XXXXXXXXXX vs bare local 10-digit dedup — exact alternate-form
  // matches only, never a generic digit-suffix match. A suffix match would
  // also hit an unrelated contact from a different country whose number
  // just happens to share the same trailing 10 digits, which is exactly
  // what previously let mergeDuplicateWhatsAppContacts delete the wrong row.
  if (digits.length === 10) {
    or.push({ phone: `91${digits}` }, { phone: `+91${digits}` });
  } else if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2);
    or.push({ phone: local }, { phone: `+${local}` });
  }

  const matches = await db.contact.findMany({
    where: {
      workspaceId,
      AND: [
        { NOT: { phone: { startsWith: 'lid:' } } },
        { NOT: { phone: { startsWith: 'group:' } } },
        { OR: or },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  if (matches.length <= 1) return matches;

  const byCanonical = new Map<string, Contact>();
  for (const contact of matches) {
    const key = whatsappCanonicalDigits(contact.phone);
    if (!key) continue;
    if (!byCanonical.has(key)) byCanonical.set(key, contact);
  }
  return byCanonical.size ? Array.from(byCanonical.values()) : matches;
}

/** @deprecated Prefer findWhatsAppContacts — kept for callers that expect a single row. */
export async function findWhatsAppContact(
  db: PrismaClient,
  workspaceId: string,
  waFrom: string
): Promise<Contact | null> {
  const matches = await findWhatsAppContacts(db, workspaceId, waFrom);
  if (matches.length === 0) return null;
  return pickCanonicalWhatsAppContact(db, matches);
}

async function pickCanonicalWhatsAppContact(
  db: PrismaClient,
  matches: Contact[]
): Promise<Contact> {
  if (matches.length === 1) return matches[0];

  const scored = await Promise.all(
    matches.map(async (contact) => ({
      contact,
      conversationCount: await db.conversation.count({ where: { contactId: contact.id } }),
    }))
  );

  scored.sort((a, b) => {
    if (b.conversationCount !== a.conversationCount) {
      return b.conversationCount - a.conversationCount;
    }
    return a.contact.createdAt.getTime() - b.contact.createdAt.getTime();
  });

  return scored[0].contact;
}

async function mergeDuplicateWhatsAppContacts(
  db: PrismaClient,
  primary: Contact,
  duplicates: Contact[]
): Promise<Contact> {
  const normalizedPhone = normalizeWhatsAppContactPhone(primary.phone);

  // Transactional so a crash mid-merge (after some rows are reassigned but
  // before the duplicate is deleted) can't leave inconsistent partial
  // state — either the whole merge lands or none of it does.
  return db.$transaction(async (tx) => {
    for (const duplicate of duplicates) {
      if (duplicate.id === primary.id) continue;

      await tx.conversation.updateMany({
        where: { contactId: duplicate.id },
        data: { contactId: primary.id },
      });
      await tx.journeyExecution.updateMany({
        where: { contactId: duplicate.id },
        data: { contactId: primary.id },
      });
      await tx.agentFlowSession.updateMany({
        where: { contactId: duplicate.id },
        data: { contactId: primary.id },
      });
      try {
        await tx.contact.delete({ where: { id: duplicate.id } });
      } catch (err) {
        // A concurrent merge for the same number already deleted this
        // duplicate — the reassignments above are idempotent no-ops against
        // an already-migrated row, so there's nothing left to do here.
        if (!isPrismaRecordNotFound(err)) throw err;
      }
    }

    if (!phonesMatch(primary.phone, normalizedPhone)) {
      return tx.contact.update({
        where: { id: primary.id },
        data: { phone: normalizedPhone },
      });
    }

    return primary;
  });
}

export async function upsertWhatsAppContact(params: {
  db: PrismaClient;
  workspaceId: string;
  waFrom: string;
  profileName?: string;
}): Promise<Contact> {
  const { db, workspaceId, waFrom, profileName } = params;
  const phone = normalizeWhatsAppContactPhone(waFrom);
  const contactName = resolveWhatsAppContactName(profileName, phone);

  let matches = await findWhatsAppContacts(db, workspaceId, waFrom);

  if (matches.length === 0) {
    try {
      return await db.contact.create({
        data: {
          name: contactName,
          phone,
          workspaceId,
          source: 'WhatsApp',
        },
      });
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      // A concurrent webhook delivery for the same brand-new number won the
      // race and already created this contact — re-fetch its row instead of
      // letting the unique-constraint error crash this delivery.
      const winner = await db.contact.findUnique({
        where: { phone_workspaceId: { phone, workspaceId } },
      });
      if (winner) return winner;
      throw err;
    }
  }

  let existing = await pickCanonicalWhatsAppContact(db, matches);
  if (matches.length > 1) {
    existing = await mergeDuplicateWhatsAppContacts(db, existing, matches);
    matches = [existing];
  }

  const shouldUpdateName =
    profileName && isPlaceholderWhatsAppContactName(existing.name, existing.phone);

  if (shouldUpdateName) {
    return db.contact.update({
      where: { id: existing.id },
      data: { name: contactName },
    });
  }

  if (!phonesMatch(existing.phone, phone)) {
    const conflict = await db.contact.findFirst({
      where: {
        workspaceId,
        phone,
        id: { not: existing.id },
      },
    });
    if (!conflict) {
      return db.contact.update({
        where: { id: existing.id },
        data: { phone },
      });
    }
  }

  return existing;
}

// ponytail: self-check — last-10 collapse for inbox dedupe
if (process.env.NODE_ENV !== 'production') {
  const a = whatsappInboxPhoneKey('919876543210');
  const b = whatsappInboxPhoneKey('9876543210');
  if (a !== b || a !== 'wa:9876543210') {
    throw new Error(`whatsappInboxPhoneKey mismatch: ${a} vs ${b}`);
  }
}
