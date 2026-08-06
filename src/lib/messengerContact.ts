import { Prisma, type Contact, type PrismaClient } from '@prisma/client';
import { formatMessengerContactPhone } from './channelContact.js';

export function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Find-or-create Messenger contact by `(phone, workspaceId)` where phone is `fb:{psid}`.
 * Catches P2002 from concurrent webhook/sync creates and re-fetches.
 */
export async function findOrCreateMessengerContact(params: {
  db: PrismaClient;
  workspaceId: string;
  psid: string;
  name: string;
  avatar?: string | null;
}): Promise<Contact> {
  const { db, workspaceId, psid, name } = params;
  const phone = formatMessengerContactPhone(psid);
  const avatar = params.avatar || undefined;

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
          source: 'Messenger',
          avatar,
        },
      });
    } catch (err) {
      // Race: webhook or sibling sync created the same fb:{psid} between find and create.
      if (!isPrismaUniqueViolation(err)) throw err;
      contact = await db.contact.findUnique({
        where: { phone_workspaceId: { phone, workspaceId } },
      });
      if (!contact) throw err;
    }
  }

  const data: { name?: string; avatar?: string } = {};
  if (contact.name === phone) data.name = name;
  if (!contact.avatar && avatar) data.avatar = avatar;
  if (!data.name && !data.avatar) return contact;

  return db.contact.update({ where: { id: contact.id }, data });
}
