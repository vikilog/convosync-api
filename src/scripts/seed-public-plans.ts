/**
 * Upsert landing pricing plans (Starter / Growth / Business / Enterprise)
 * with compare-features, then create missing Razorpay plan IDs.
 *
 *   npm run plans:seed
 */
import 'dotenv/config';
import Razorpay from 'razorpay';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { isValidRazorpayPlanId } from '../services/razorpayPlanSync.js';
import {
  DEFAULT_PLAN_SEEDS,
  provisionRazorpayPlanIds,
  seedSubscriptionPlans,
} from '../services/subscriptionPlans.js';

async function main() {
  console.log(`Seeding ${DEFAULT_PLAN_SEEDS.length} public plans from landing catalog…`);
  const plans = await seedSubscriptionPlans();

  for (const p of plans) {
    const f = p.features as Record<string, unknown>;
    console.log(
      `  ✓ ${p.name} (${p.slug}) ₹${p.priceMonthly ?? 'Custom'}/mo · seats=${f.teamMembers} · channels=${f.channels} · storage=${f.storageGb != null ? `${f.storageGb} GB` : 'Custom'}`
    );
  }

  if (!config.razorpay.enabled) {
    console.warn('\nRazorpay keys missing — plans saved without new Razorpay IDs.');
    console.warn('Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET, then re-run.');
    return;
  }

  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  const fakeFastify = { razorpay: client } as ConstructorParameters<typeof RazorpayService>[0];
  const razorpay = new RazorpayService(fakeFastify);
  const createPlan = (params: Parameters<RazorpayService['createPlan']>[0]) =>
    razorpay.createPlan(params);

  console.log('\nProvisioning Razorpay plan IDs where missing…');
  for (const plan of plans) {
    const needsMonthly =
      !!plan.priceMonthlyPaise && !isValidRazorpayPlanId(plan.razorpayPlanIdMonthly);
    const needsAnnual =
      !!plan.priceAnnualPaise && !isValidRazorpayPlanId(plan.razorpayPlanIdAnnual);

    if (!needsMonthly && !needsAnnual) {
      console.log(
        `  · ${plan.slug}: already linked (${plan.razorpayPlanIdMonthly ?? '—'} / ${plan.razorpayPlanIdAnnual ?? '—'})`
      );
      continue;
    }

    const result = await provisionRazorpayPlanIds(
      {
        id: plan.id,
        name: plan.name,
        slug: plan.slug,
        priceMonthly: needsMonthly ? plan.priceMonthly : null,
        priceAnnual: needsAnnual ? plan.priceAnnual : null,
        priceMonthlyPaise: needsMonthly ? plan.priceMonthlyPaise : null,
        priceAnnualPaise: needsAnnual ? plan.priceAnnualPaise : null,
      },
      createPlan
    );

    if (result.warnings.length) {
      console.warn(`  ! ${plan.slug}: ${result.warnings.join(' · ')}`);
    }

    const fresh = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: plan.id } });
    console.log(
      `  ✓ ${plan.slug}: monthly=${fresh.razorpayPlanIdMonthly ?? '—'} annual=${fresh.razorpayPlanIdAnnual ?? '—'}`
    );
  }

  console.log('\nDone. Refresh Super Admin → Plans.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
