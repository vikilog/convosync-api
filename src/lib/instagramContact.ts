import { Prisma, type Contact, type PrismaClient } from '@prisma/client';
import {
  formatInstagramContactPhone,
  isInstagramPhone,
  isMessengerPhone,
  isMessengerSource,
} from './channelContact.js';
import { isInstagramPlaceholderContactName } from './instagramProfile.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Legacy IG contacts sometimes stored the raw IGSID (15+ digits) with no ig: prefix. */
function isLegacyBareIgsid(value: string): boolean {
  return /^\d{15,}$/.test(value.trim());
}

/**
 * Find-or-create Instagram contact by `ig:{scopedUserId}` only.
 * Never reuses Messenger (`fb:` / source Messenger) contacts — same human
 * keeps a separate IG identity so channel threads stay distinct.
 * Heals legacy bare-IGSID rows (source Instagram) into `ig:{id}`.
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

  // Legacy: bare IGSID without ig: — reuse + heal (never adopt Messenger rows).
  if (!contact && isLegacyBareIgsid(scopedUserId)) {
    const bare = await db.contact.findUnique({
      where: { phone_workspaceId: { phone: scopedUserId, workspaceId } },
    });
    if (
      bare &&
      !isMessengerPhone(bare.phone) &&
      !isMessengerSource(bare.source)
    ) {
      try {
        contact = await db.contact.update({
          where: { id: bare.id },
          data: {
            phone,
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
  }

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

  // Existing row kept Instagram ##### forever — overwrite when a better name arrives.
  const betterName = params.name?.trim();
  if (
    betterName &&
    !isInstagramPlaceholderContactName(betterName, scopedUserId) &&
    isInstagramPlaceholderContactName(contact.name, scopedUserId)
  ) {
    contact = await db.contact.update({
      where: { id: contact.id },
      data: { name: betterName },
    });
  }

  return contact;
}
