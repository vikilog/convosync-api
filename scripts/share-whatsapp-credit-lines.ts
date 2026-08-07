/**
 * Backfill Meta credit-line share for already-onboarded client WABAs.
 * Requires META_CREDIT_LINE_ID (+ META_SYSTEM_USER_TOKEN or SUPER_ADMIN_ACCESS_TOKEN).
 *
 * Usage:
 *   npx tsx scripts/share-whatsapp-credit-lines.ts
 *   npx tsx scripts/share-whatsapp-credit-lines.ts --waba=102290129340398
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { shareCreditLineWithWaba } from '../src/services/whatsappCreditLine.js';

async function main() {
  const wabaFlag = process.argv.find((a) => a.startsWith('--waba='));
  const onlyWaba = wabaFlag?.slice('--waba='.length)?.trim();

  if (!config.meta.creditLineId || !config.meta.systemUserToken) {
    console.error(
      'Set META_CREDIT_LINE_ID (or WHATSAPP_EXTENDED_CREDIT_ID) and META_SYSTEM_USER_TOKEN (or SUPER_ADMIN_ACCESS_TOKEN).'
    );
    process.exit(1);
  }

  const rows = onlyWaba
    ? [{ wabaId: onlyWaba }]
    : await prisma.whatsAppPhoneAccount.findMany({
        where: { wabaId: { not: '' } },
        distinct: ['wabaId'],
        select: { wabaId: true },
      });

  console.log(`Sharing credit line with ${rows.length} WABA(s)…`);

  let ok = 0;
  let fail = 0;
  for (const { wabaId } of rows) {
    const result = await shareCreditLineWithWaba(wabaId);
    if (result.shared) {
      ok += 1;
      console.log(
        JSON.stringify({
          wabaId,
          shared: true,
          alreadyShared: result.alreadyShared || false,
          allocationConfigId: result.allocationConfigId,
        })
      );
    } else {
      fail += 1;
      console.error(JSON.stringify({ wabaId, shared: false, error: result.error || result.details }));
    }
  }

  console.log(`Done. shared=${ok} failed=${fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
