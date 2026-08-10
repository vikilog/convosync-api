import { Prisma, type Contact, type PrismaClient } from '@prisma/client';
import {
  formatMessengerContactPhone,
  isInstagramPhone,
  isInstagramSource,
  normalizeMessengerPsid,
} from './channelContact.js';

export function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Find-or-create Messenger contact by `(phone, workspaceId)` where phone is `fb:{psid}`.
 * Also heals legacy rows that stored the bare PSID (no fb: prefix) — but never
 * adopts Instagram `ig:` / source=Instagram rows (same digits can be an IGSID).
 * Catches P2002 from concurrent webhook/sync creates and re-fetches.
 */
export async function findOrCreateMessengerContact(params: {
  db: PrismaClient;
  workspaceId: string;
  psid: string;
  name: string;
  avatar?: string | null;
}): Promise<Contact> {
  const { db, workspaceId, name } = params;
  const psid = normalizeMessengerPsid(params.psid);
  if (!psid) {
    throw new Error('Messenger PSID is required');
  }
  const phone = formatMessengerContactPhone(psid);
  const avatar = params.avatar || undefined;

  let contact = await db.contact.findUnique({
    where: { phone_workspaceId: { phone, workspaceId } },
  });

  // Legacy: sync/webhook once stored raw PSID without fb: — reuse + heal.
  // Do not steal Instagram identities (bare IGSID / source Instagram).
  if (!contact) {
    const bare = await db.contact.findUnique({
      where: { phone_workspaceId: { phone: psid, workspaceId } },
    });
    if (
      bare &&
      !isInstagramPhone(bare.phone) &&
      !isInstagramSource(bare.source)
    ) {
      try {
        contact = await db.contact.update({
          where: { id: bare.id },
          data: {
            phone,
            source: bare.source || 'Messenger',
          },
        });
      } catch (err) {
        // fb:{psid} already taken — use that row (bare legacy becomes orphan).
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

  // Defensive: never treat an Instagram identity row as Messenger.
  if (isInstagramPhone(contact.phone) || isInstagramSource(contact.source)) {
    throw new Error(`Messenger contact has Instagram identity: ${contact.phone}`);
  }

  const data: { name?: string; avatar?: string; phone?: string; source?: string } = {};
  if (contact.phone !== phone) data.phone = phone;
  if (!contact.source || contact.source === '—') data.source = 'Messenger';
  if (contact.name === phone || contact.name === psid || contact.name === contact.phone) {
    data.name = name;
  }
  if (!contact.avatar && avatar) data.avatar = avatar;
  if (!data.name && !data.avatar && !data.phone && !data.source) return contact;

  return db.contact.update({ where: { id: contact.id }, data });
}
