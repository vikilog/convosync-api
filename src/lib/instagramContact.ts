import { Prisma, type Contact, type PrismaClient } from '@prisma/client';
import { formatInstagramContactPhone, isInstagramPhone } from './channelContact.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Find-or-create Instagram contact by `ig:{scopedUserId}` only.
 * Never reuses Messenger (`fb:` / bare PSID) or WhatsApp contacts — same human
 * keeps a separate IG identity so channel threads stay distinct.
 */
export async function findOrCreateInstagramContact(params: {
  db: PrismaClient;
  workspaceId: string;
  scopedUserId: string;
  name?: string;
}): Promise<Contact> {
  const { db, workspaceId } = params;
  const scopedUserId = params.scopedUserId.trim();
  if (!scopedUserId) {
    throw new Error('Instagram scoped user id is required');
  }
  const phone = formatInstagramContactPhone(scopedUserId);
  const name = params.name?.trim() || `Instagram ${scopedUserId.slice(-6)}`;

  let contact = await db.contact.findUnique({
    where: { phone_workspaceId: { phone, workspaceId } },
  });

  if (!contact) {
    try {
      contact = await db.contact.create({
        data: {
          name,
          phone,
          workspaceId,
          source: 'Instagram',
        },
      });
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      contact = await db.contact.findUnique({
        where: { phone_workspaceId: { phone, workspaceId } },
      });
      if (!contact) throw err;
    }
  }

  // Defensive: never treat a non-ig phone row as Instagram identity.
  if (!isInstagramPhone(contact.phone)) {
    throw new Error(`Instagram contact has invalid phone identity: ${contact.phone}`);
  }

  return contact;
}
