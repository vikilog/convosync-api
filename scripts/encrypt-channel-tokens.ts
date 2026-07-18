/**
 * Encrypt existing plaintext channel tokens in the DB.
 *
 * Dry-run (default):
 *   npx tsx scripts/encrypt-channel-tokens.ts
 *
 * Apply writes:
 *   npx tsx scripts/encrypt-channel-tokens.ts --apply
 *
 * Requires EMAIL_CONFIG_ENCRYPTION_KEY or ENCRYPTION_KEY or JWT_SECRET
 * (same key as field-encryption.ts). Do NOT run --apply on production
 * until you have reviewed the dry-run counts and backed up the DB.
 */
import { PrismaClient } from '@prisma/client';
import {
  SECRET_PREFIX,
  encryptSecretIfPlain,
} from '../src/lib/field-encryption.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

function needsEncrypt(value: string | null | undefined): boolean {
  return Boolean(value && !value.startsWith(SECRET_PREFIX));
}

async function main() {
  const workspaces = await prisma.workspace.findMany({
    select: {
      id: true,
      waToken: true,
      fbPageToken: true,
      metaUserToken: true,
    },
  });
  const igAccounts = await prisma.instagramAccount.findMany({
    select: { id: true, pageAccessToken: true },
  });
  const messengerAccounts = await prisma.messengerAccount.findMany({
    select: { id: true, pageAccessToken: true },
  });

  let wa = 0;
  let fb = 0;
  let meta = 0;
  let ig = 0;
  let messenger = 0;

  for (const row of workspaces) {
    const data: {
      waToken?: string;
      fbPageToken?: string;
      metaUserToken?: string;
    } = {};
    if (needsEncrypt(row.waToken)) {
      data.waToken = encryptSecretIfPlain(row.waToken)!;
      wa += 1;
    }
    if (needsEncrypt(row.fbPageToken)) {
      data.fbPageToken = encryptSecretIfPlain(row.fbPageToken)!;
      fb += 1;
    }
    if (needsEncrypt(row.metaUserToken)) {
      data.metaUserToken = encryptSecretIfPlain(row.metaUserToken)!;
      meta += 1;
    }
    if (apply && Object.keys(data).length > 0) {
      await prisma.workspace.update({ where: { id: row.id }, data });
    }
  }

  for (const row of igAccounts) {
    if (!needsEncrypt(row.pageAccessToken)) continue;
    ig += 1;
    if (apply) {
      await prisma.instagramAccount.update({
        where: { id: row.id },
        data: { pageAccessToken: encryptSecretIfPlain(row.pageAccessToken)! },
      });
    }
  }

  for (const row of messengerAccounts) {
    if (!needsEncrypt(row.pageAccessToken)) continue;
    messenger += 1;
    if (apply) {
      await prisma.messengerAccount.update({
        where: { id: row.id },
        data: { pageAccessToken: encryptSecretIfPlain(row.pageAccessToken)! },
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        wouldEncrypt: { waToken: wa, fbPageToken: fb, metaUserToken: meta, igPageAccessToken: ig, messengerPageAccessToken: messenger },
        total: wa + fb + meta + ig + messenger,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write encrypted values.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
