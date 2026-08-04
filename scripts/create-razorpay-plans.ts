/**
 * Create self-serve Razorpay subscription plans (Starter / Growth / Business).
 * Prints plan IDs for manual copy into Super Admin or live DB — does not write to DB.
 *
 *   cd backend && npm run razorpay:create-plans
 *   cd backend && npm run razorpay:create-plans -- --dry-run
 */
import 'dotenv/config';
import Razorpay from 'razorpay';
import { config } from '../src/config.js';
import { RazorpayService } from '../src/modules/billing/razorpay.service.js';
import { DEFAULT_PLAN_SEEDS } from '../src/services/subscriptionPlans.js';

type BillingCycle = 'monthly' | 'annual';

type RazorpayPlanRow = {
  id: string;
  period: string;
  interval: number;
  notes?: Record<string, string>;
  item?: { name?: string; amount?: number; currency?: string };
};

type PlanResult = {
  slug: string;
  cycle: BillingCycle;
  amountPaise: number;
  name: string;
  razorpayPlanId: string;
  status: 'created' | 'existing' | 'dry-run';
};

function parseArgs(argv: string[]) {
  return { dryRun: argv.includes('--dry-run') };
}

function razorpayKeyMode(keyId: string): 'test' | 'live' | 'unknown' {
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return 'unknown';
}

function formatInr(paise: number) {
  return (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
}

function planDisplayName(seedName: string) {
  const trimmed = seedName.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function razorpayPlanName(seedName: string, cycle: BillingCycle) {
  const label = planDisplayName(seedName);
  return cycle === 'monthly' ? `ConvoSync ${label} Monthly` : `ConvoSync ${label} Annual`;
}

function razorpayPeriod(cycle: BillingCycle): 'monthly' | 'yearly' {
  return cycle === 'monthly' ? 'monthly' : 'yearly';
}

async function fetchAllRazorpayPlans(client: Razorpay): Promise<RazorpayPlanRow[]> {
  const plans: RazorpayPlanRow[] = [];
  let skip = 0;
  const count = 100;

  for (;;) {
    const page = (await client.plans.all({ count, skip })) as { items?: RazorpayPlanRow[] };
    const items = page.items ?? [];
    plans.push(...items);
    if (items.length < count) break;
    skip += count;
    if (skip > 500) break;
  }

  return plans;
}

function findExistingPlan(
  remotePlans: RazorpayPlanRow[],
  slug: string,
  cycle: BillingCycle,
  amountPaise: number,
  expectedName: string
): RazorpayPlanRow | null {
  const period = razorpayPeriod(cycle);
  const noteCycle = cycle === 'monthly' ? 'monthly' : 'annual';

  const byNotes = remotePlans.filter(
    (p) =>
      p.period === period &&
      p.interval === 1 &&
      p.notes?.convosync_slug === slug &&
      p.notes?.cycle === noteCycle
  );
  if (byNotes.length > 0) return byNotes[byNotes.length - 1]!;

  const byName = remotePlans.filter(
    (p) =>
      p.period === period &&
      p.interval === 1 &&
      p.item?.currency === 'INR' &&
      p.item?.name?.trim() === expectedName
  );
  if (byName.length > 0) return byName[byName.length - 1]!;

  const byAmount = remotePlans.filter(
    (p) =>
      p.period === period &&
      p.interval === 1 &&
      p.item?.currency === 'INR' &&
      p.item?.amount === amountPaise
  );
  if (byAmount.length === 1) return byAmount[0]!;

  return null;
}

function printSummaryTable(results: PlanResult[]) {
  const slugW = Math.max(4, ...results.map((r) => r.slug.length));
  const cycleW = 7;
  const amountW = 14;
  const idW = Math.max(16, ...results.map((r) => r.razorpayPlanId.length));

  console.log('\nCopy-paste summary:\n');
  console.log(
    `${'slug'.padEnd(slugW)}  ${'cycle'.padEnd(cycleW)}  ${'amount'.padEnd(amountW)}  ${'razorpay_plan_id'.padEnd(idW)}  status`
  );
  console.log(`${'-'.repeat(slugW)}  ${'-'.repeat(cycleW)}  ${'-'.repeat(amountW)}  ${'-'.repeat(idW)}  ------`);

  for (const row of results) {
    console.log(
      `${row.slug.padEnd(slugW)}  ${row.cycle.padEnd(cycleW)}  ${formatInr(row.amountPaise).padStart(amountW)}  ${row.razorpayPlanId.padEnd(idW)}  ${row.status}`
    );
  }
}

function printEnvVars(results: PlanResult[]) {
  console.log('\nOptional .env overrides:\n');
  for (const row of results) {
    const suffix = row.cycle === 'monthly' ? 'MONTHLY' : 'ANNUAL';
    console.log(`RAZORPAY_PLAN_${row.slug.toUpperCase()}_${suffix}="${row.razorpayPlanId}"`);
  }
}

function printAdminHint(results: PlanResult[]) {
  const bySlug = new Map<string, { monthly?: string; annual?: string }>();
  for (const row of results) {
    const entry = bySlug.get(row.slug) ?? {};
    if (row.cycle === 'monthly') entry.monthly = row.razorpayPlanId;
    else entry.annual = row.razorpayPlanId;
    bySlug.set(row.slug, entry);
  }

  console.log('\nSuper Admin → Plans (or SQL on live DB):\n');
  for (const [slug, ids] of bySlug) {
    const parts: string[] = [];
    if (ids.monthly) parts.push(`razorpayPlanIdMonthly = ${ids.monthly}`);
    if (ids.annual) parts.push(`razorpayPlanIdAnnual = ${ids.annual}`);
    console.log(`  ${slug}: ${parts.join(', ')}`);
  }
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  if (!config.razorpay.enabled) {
    console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env first.');
    process.exit(1);
  }

  const keyMode = razorpayKeyMode(config.razorpay.keyId);
  if (keyMode === 'test') {
    console.warn('⚠ Using Razorpay TEST keys (rzp_test_*). Plans will be created in test mode.');
    console.warn('  For live production plans, switch to rzp_live_* keys in backend/.env.\n');
  } else if (keyMode === 'live') {
    console.warn('⚠ Using Razorpay LIVE keys (rzp_live_*). This creates real billing plans.\n');
  } else {
    console.warn(`⚠ Unrecognized key prefix (${config.razorpay.keyId.slice(0, 12)}…). Verify test vs live.\n`);
  }

  const selfServePlans = DEFAULT_PLAN_SEEDS.filter(
    (seed) =>
      seed.slug !== 'enterprise' &&
      seed.priceMonthlyPaise != null &&
      seed.priceMonthlyPaise > 0 &&
      seed.priceAnnualPaise != null &&
      seed.priceAnnualPaise > 0
  );

  if (selfServePlans.length === 0) {
    console.error('No self-serve plans found in DEFAULT_PLAN_SEEDS.');
    process.exit(1);
  }

  console.log(
    dryRun
      ? 'Dry run — no Razorpay API writes. Would create:\n'
      : 'Creating Razorpay subscription plans (DB not modified):\n'
  );

  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  const fakeFastify = { razorpay: client } as ConstructorParameters<typeof RazorpayService>[0];
  const razorpay = new RazorpayService(fakeFastify);

  const remotePlans = dryRun ? [] : await fetchAllRazorpayPlans(client);
  const results: PlanResult[] = [];

  for (const seed of selfServePlans) {
    const cycles: Array<{ cycle: BillingCycle; amountPaise: number }> = [
      { cycle: 'monthly', amountPaise: seed.priceMonthlyPaise! },
      { cycle: 'annual', amountPaise: seed.priceAnnualPaise! },
    ];

    for (const { cycle, amountPaise } of cycles) {
      const name = razorpayPlanName(seed.name, cycle);
      const description = `ConvoSync ${planDisplayName(seed.name)} (${cycle})`;

      if (dryRun) {
        console.log(`  [dry-run] ${seed.slug} ${cycle}: ${name} @ ${formatInr(amountPaise)}`);
        results.push({
          slug: seed.slug,
          cycle,
          amountPaise,
          name,
          razorpayPlanId: '(dry-run)',
          status: 'dry-run',
        });
        continue;
      }

      const existing = findExistingPlan(remotePlans, seed.slug, cycle, amountPaise, name);
      if (existing) {
        console.log(
          `  · ${seed.slug} ${cycle}: already exists ${existing.id} (${existing.item?.name ?? name})`
        );
        results.push({
          slug: seed.slug,
          cycle,
          amountPaise,
          name,
          razorpayPlanId: existing.id,
          status: 'existing',
        });
        continue;
      }

      const created = await razorpay.createPlan({
        name,
        amountPaise,
        period: razorpayPeriod(cycle),
        description,
        notes: { convosync_slug: seed.slug, cycle },
      });

      console.log(`  ✓ ${seed.slug} ${cycle}: created ${created.id} (${name} @ ${formatInr(amountPaise)})`);
      results.push({
        slug: seed.slug,
        cycle,
        amountPaise,
        name,
        razorpayPlanId: created.id,
        status: 'created',
      });
    }
  }

  printSummaryTable(results);
  if (!dryRun) {
    printEnvVars(results);
    printAdminHint(results);
  }

  console.log('\nDone. Update live plan IDs manually — this script does not write to the database.');
  if (!dryRun) {
    console.log(
      'Re-runs skip plans matched by notes (convosync_slug + cycle), name, or unique amount+period.'
    );
    console.log('Razorpay allows duplicate plans; delete unused ones in Dashboard if you re-create.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
