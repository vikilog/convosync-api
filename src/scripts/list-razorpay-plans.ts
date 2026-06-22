import 'dotenv/config';
import Razorpay from 'razorpay';
import { config } from '../config.js';

async function main() {
  if (!config.razorpay.enabled) {
    console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env first.');
    process.exit(1);
  }

  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  const plans: Array<{
    id: string;
    period: string;
    item?: { name?: string; amount?: number; currency?: string };
  }> = [];

  let skip = 0;
  for (;;) {
    const page = (await client.plans.all({ count: 100, skip })) as {
      items?: typeof plans;
    };
    const items = page.items ?? [];
    plans.push(...items);
    if (items.length < 100) break;
    skip += 100;
  }

  if (plans.length === 0) {
    console.log('No plans found in Razorpay. Create plans in Dashboard → Subscriptions → Plans.');
    return;
  }

  console.log('Razorpay plans (copy IDs into backend/.env if amounts do not auto-match):\n');
  for (const plan of plans) {
    const amount = plan.item?.amount ?? 0;
    const inr = (amount / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
    console.log(`${plan.id}  ${plan.period.padEnd(8)}  ${inr.padStart(12)}  ${plan.item?.name ?? ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
