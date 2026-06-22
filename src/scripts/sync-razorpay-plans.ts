import 'dotenv/config';
import Razorpay from 'razorpay';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { logRazorpayPlanSync, syncRazorpayPlanIds } from '../services/razorpayPlanSync.js';

async function main() {
  if (!config.razorpay.enabled) {
    console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env first.');
    process.exit(1);
  }

  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  const result = await syncRazorpayPlanIds(client);
  logRazorpayPlanSync(result, (msg) => console.log(msg));

  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      slug: true,
      name: true,
      priceMonthlyPaise: true,
      priceAnnualPaise: true,
      razorpayPlanIdMonthly: true,
      razorpayPlanIdAnnual: true,
    },
  });

  console.log('\nCurrent plan linkage:');
  for (const p of plans) {
    console.log(
      `- ${p.name} (${p.slug}): monthly=${p.razorpayPlanIdMonthly ?? 'MISSING'} (₹${((p.priceMonthlyPaise ?? 0) / 100).toLocaleString('en-IN')}), annual=${p.razorpayPlanIdAnnual ?? 'MISSING'} (₹${((p.priceAnnualPaise ?? 0) / 100).toLocaleString('en-IN')})`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
