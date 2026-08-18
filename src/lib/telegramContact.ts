import type { Contact, PrismaClient } from '@prisma/client';
import { formatTelegramContactPhone } from './channelContact.js';
import { isPrismaUniqueViolation } from './messengerContact.js';

/**
 * Find-or-create Telegram contact by `(phone, workspaceId)` where phone is `tg:{chatId}`.
 */
export async function findOrCreateTelegramContact(params: {
  db: PrismaClient;
  workspaceId: string;
  chatId: string;
  name: string;
  avatar?: string | null;
}): Promise<Contact> {
  const { db, workspaceId, name } = params;
  const chatId = params.chatId.trim();
  if (!chatId) {
    throw new Error('Telegram chat id is required');
  }
  const phone = formatTelegramContactPhone(chatId);
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
          source: 'Telegram',
          avatar,
        },
      });
    } catch (err) {
      // Race: webhook delivered the same chat twice between find and create.
      if (!isPrismaUniqueViolation(err)) throw err;
      contact = await db.contact.findUnique({
        where: { phone_workspaceId: { phone, workspaceId } },
      });
      if (!contact) throw err;
    }
  }

  const data: { name?: string; avatar?: string; source?: string } = {};
  if (!contact.source || contact.source === '—') data.source = 'Telegram';
  if (contact.name === phone || contact.name === chatId) data.name = name;
  if (!contact.avatar && avatar) data.avatar = avatar;
  if (!data.name && !data.avatar && !data.source) return contact;

  return db.contact.update({ where: { id: contact.id }, data });
}
