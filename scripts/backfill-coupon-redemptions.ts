/**
 * One-shot backfill: create DiscountCouponRedemption rows from paid plan_purchase invoices.
 *
 *   npx tsx scripts/backfill-coupon-redemptions.ts
 */
import 'dotenv/config';
import {
  backfillCouponRedemptionsFromInvoices,
  getDiscountCouponDetail,
} from '../src/services/discountCoupons.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const result = await backfillCouponRedemptionsFromInvoices();
  console.log('Backfill complete:', result);

  const welcome = await getDiscountCouponDetail(
    (await prisma.discountCoupon.findUnique({ where: { code: 'WELCOME' }, select: { id: true } }))!
      .id
  );
  if (welcome) {
    console.log(
      `WELCOME: ${welcome.redemptionCount} redemptions, ${welcome.uniqueWorkspaceCount} workspaces, ledger=${welcome.redemptions.length}`
    );
    for (const r of welcome.redemptions) {
      console.log(`  · ${r.workspaceName} (${r.workspaceSlug}) −${r.discountAmountPaise} paise`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
