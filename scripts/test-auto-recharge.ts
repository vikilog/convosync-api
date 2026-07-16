/**
 * One-shot manual test for wallet auto-recharge (auto-cut).
 *
 * Full test (drops balance below threshold + charges saved payment method):
 *   npm run wallet:test-auto-recharge -- --email you@example.com
 *
 * Only check readiness:
 *   npm run wallet:test-auto-recharge -- --email you@example.com --check
 *
 * Force trigger without debiting:
 *   npm run wallet:test-auto-recharge -- --email you@example.com --trigger-only
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { debitWallet, ensureWallet, getWalletSummary } from '../src/services/wallet.service.js';
import { processWalletAutoRecharge } from '../src/services/walletAutoRecharge.service.js';
import { RazorpayService } from '../src/modules/billing/razorpay.service.js';
import Razorpay from 'razorpay';
import { config } from '../src/config.js';

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const cc = (paise: number) => paise / 100;

async function resolveWorkspace(opts: Record<string, string | boolean>) {
  if (typeof opts['workspace-id'] === 'string') {
    const workspace = await prisma.workspace.findUnique({
      where: { id: opts['workspace-id'] },
      select: { id: true, name: true, email: true, razorpayCustomerId: true },
    });
    if (!workspace) throw new Error(`Workspace not found: ${opts['workspace-id']}`);
    return workspace;
  }

  const email =
    (typeof opts.email === 'string' ? opts.email : process.env.TEST_USER_EMAIL)?.trim().toLowerCase();
  if (!email) {
    throw new Error('Pass --email you@example.com (or set TEST_USER_EMAIL in .env)');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      workspace: { select: { id: true, name: true, email: true, razorpayCustomerId: true } },
    },
  });
  if (!user?.workspace) throw new Error(`No workspace for email: ${email}`);
  return user.workspace;
}

function printChecklist(
  wallet: Awaited<ReturnType<typeof getWalletSummary>>,
  razorpayCustomerId: string | null | undefined
) {
  const checks = [
    { ok: wallet.autoRechargeEnabled, label: 'Auto-recharge enabled in Wallet settings' },
    { ok: wallet.hasPaymentMethod, label: 'Saved Razorpay payment method (token)' },
    { ok: Boolean(razorpayCustomerId), label: 'Razorpay customer linked to workspace' },
    { ok: wallet.isLowBalance, label: `Balance ≤ threshold (${cc(wallet.balancePaise)} / ${cc(wallet.lowBalanceThresholdPaise)} CC)` },
    { ok: wallet.autoRechargeStatus !== 'charging', label: `Not already charging (status: ${wallet.autoRechargeStatus})` },
  ];

  console.log('Pre-flight checks:');
  for (const item of checks) {
    console.log(`  ${item.ok ? '✓' : '✗'} ${item.label}`);
  }
  console.log('');
  return checks.every((c) => c.ok || c.label.startsWith('Balance')); // balance fixable
}

async function printRecentTx(workspaceId: string) {
  const rows = await prisma.walletTransaction.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  if (rows.length === 0) {
    console.log('No wallet transactions yet.');
    return;
  }
  console.log('Recent transactions:');
  for (const row of rows) {
    const sign = row.type === 'credit' ? '+' : '-';
    console.log(
      `  ${row.createdAt.toISOString()} | ${sign}${cc(row.amountPaise)} CC | ${row.description ?? row.category} | balance ${cc(row.balanceAfterPaise)} CC`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || opts.h) {
    console.log(`
Usage: npm run wallet:test-auto-recharge -- --email you@example.com

Options:
  --email <email>         Login email (or TEST_USER_EMAIL in .env)
  --workspace-id <id>     Workspace id instead of email
  --balance <cc>          Target balance before auto-cut (default: threshold - 50 CC)
  --check                 Only run pre-flight checks, no debit/charge
  --trigger-only          Skip debit, only clear cooldown + run auto-recharge
  --diagnose              Verify Razorpay customer/token (no charge)
  --help                  Show help

What the full test does:
  1. Shows wallet state + pre-flight checks
  2. Debits coins until balance is below low-balance threshold (if needed)
  3. Clears cooldown / charging lock
  4. Runs Razorpay token charge (same as production auto-recharge)
  5. Shows updated balance + recent transactions
`);
    return;
  }

  const workspace = await resolveWorkspace(opts);
  await ensureWallet(workspace.id);

  const rawWallet = await prisma.workspaceWallet.findUniqueOrThrow({
    where: { workspaceId: workspace.id },
  });

  let wallet = await getWalletSummary(workspace.id);

  console.log('=== Auto-recharge manual test ===\n');
  console.log(`Workspace: ${workspace.name}`);
  console.log(`Email: ${workspace.email ?? '(not set)'}`);
  console.log(`Balance: ${cc(wallet.balancePaise)} CC`);
  console.log(`Threshold: ${cc(wallet.lowBalanceThresholdPaise)} CC`);
  console.log(`Auto-recharge amount: ${cc(wallet.autoRechargeAmountPaise)} CC`);
  console.log(`Razorpay customer: ${workspace.razorpayCustomerId ?? 'missing'}`);
  console.log(`Razorpay token: ${rawWallet.razorpayTokenId ?? 'missing'}`);
  console.log('');

  printChecklist(wallet, workspace.razorpayCustomerId);

  if (opts.check) {
    console.log('All setup looks good. Run the actual charge with:');
    console.log(`  npm run wallet:test-auto-recharge -- --email ${workspace.email ?? 'YOUR_EMAIL'} --trigger-only\n`);
    return;
  }

  if (opts.diagnose) {
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing in .env');
    }
    const client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
    const razorpay = new RazorpayService({ razorpay: client } as never);

    console.log('Razorpay diagnose (no charge):');
    try {
      const customer = await razorpay.fetchCustomer(workspace.razorpayCustomerId!);
      console.log(`  ✓ Customer exists: ${customer.id}`);
    } catch (err) {
      console.log(`  ✗ Customer lookup failed: ${formatErr(err)}`);
      console.log('    → API keys may not match the customer (test vs live).');
    }

    try {
      const tokens = await razorpay.fetchCustomerTokens(workspace.razorpayCustomerId!);
      const items = tokens.items ?? [];
      const hasToken = items.some((t) => t.id === rawWallet.razorpayTokenId);
      console.log(`  Tokens on customer: ${items.length}`);
      for (const token of items) {
        const mark = token.id === rawWallet.razorpayTokenId ? ' (saved in DB)' : '';
        console.log(`    - ${token.id} method=${token.method ?? '?'} recurring=${token.recurring ?? '?'}${mark}`);
      }
      if (!hasToken && rawWallet.razorpayTokenId) {
        console.log('  ✗ Saved token not found on Razorpay customer — re-save payment method.');
      }
    } catch (err) {
      console.log(`  ✗ Token lookup failed: ${formatErr(err)}`);
      console.log('    → Enable Recurring Payments in Razorpay Dashboard → Products.');
    }

    console.log('\nIf customer + token look good but charge fails with "URL not found":');
    console.log('  → Razorpay Recurring Payments API is NOT enabled on this merchant account.');
    console.log('  → Dashboard → Account & Settings → Products → request Recurring Payments.');
    console.log('  → Or email Razorpay support to enable /payments/create/recurring for your account.');
    console.log('\nAfter Razorpay enables it, reset failed state:');
    console.log(`  npm run wallet:reset-auto-recharge -- --email ${workspace.email ?? 'YOUR_EMAIL'}`);
    console.log('\nThen retry charge:');
    console.log(`  npm run wallet:test-auto-recharge -- --email ${workspace.email ?? 'YOUR_EMAIL'} --trigger-only`);
    return;
  }

  if (!wallet.autoRechargeEnabled) {
    throw new Error('Turn ON auto-recharge in Settings → Wallet first.');
  }
  if (!wallet.hasPaymentMethod) {
    throw new Error('Save a payment method via Wallet → auto-recharge setup first.');
  }

  if (!opts['trigger-only']) {
    const thresholdCc = cc(wallet.lowBalanceThresholdPaise);
    const targetCc =
      typeof opts.balance === 'string'
        ? Number(opts.balance)
        : Math.max(0, thresholdCc - 50);

    if (!Number.isFinite(targetCc) || targetCc < 0) {
      throw new Error('--balance must be a non-negative number (CC)');
    }

    if (wallet.balancePaise > ccToPaise(targetCc)) {
      const debitPaise = wallet.balancePaise - ccToPaise(targetCc);
      console.log(`Step 1: Debiting ${cc(debitPaise)} CC → target balance ${targetCc} CC...`);
      await debitWallet({
        workspaceId: workspace.id,
        amountPaise: debitPaise,
        category: 'adjustment',
        description: 'Auto-recharge test script',
        referenceType: 'test_auto_recharge',
        idempotencyKey: `test-auto-recharge:${workspace.id}:${Date.now()}`,
      });
      wallet = await getWalletSummary(workspace.id);
      console.log(`  New balance: ${cc(wallet.balancePaise)} CC\n`);
    } else {
      console.log(`Step 1: Balance already ${cc(wallet.balancePaise)} CC (≤ threshold). Skipping debit.\n`);
    }
  }

  if (!wallet.isLowBalance) {
    throw new Error(
      `Balance ${cc(wallet.balancePaise)} CC is still above threshold ${cc(wallet.lowBalanceThresholdPaise)} CC. Use --balance to set lower.`
    );
  }

  console.log('Step 2: Clearing cooldown / charging lock...');
  await prisma.workspaceWallet.update({
    where: { workspaceId: workspace.id },
    data: { autoRechargeStatus: 'idle', autoRechargeCooldownUntil: null },
  });
  console.log('  Done.\n');

  console.log('Step 3: Running auto-recharge (Razorpay token charge)...');
  const balanceBefore = wallet.balancePaise;

  try {
    await processWalletAutoRecharge(workspace.id);
  } catch (err) {
    console.log(err);
    console.error('\n✗ Auto-recharge FAILED');
    console.error(formatErr(err));
    console.log('\nCommon fixes:');
    console.log('  1. Razorpay Dashboard → Products → enable Recurring Payments / Tokenisation');
    console.log('  2. Same test/live keys as when payment method was saved');
    console.log('  3. Card test token works more reliably than UPI in test mode');
    console.log('  4. Run: npm run wallet:test-auto-recharge -- --email ... --diagnose');
    process.exitCode = 1;
    return;
  }

  wallet = await getWalletSummary(workspace.id);
  const credited = wallet.balancePaise - balanceBefore;

  console.log('\n=== Result ===');
  console.log(`✓ Auto-recharge succeeded`);
  console.log(`  Balance before: ${cc(balanceBefore)} CC`);
  console.log(`  Balance after:  ${cc(wallet.balancePaise)} CC`);
  console.log(`  Credited:       +${cc(credited)} CC`);
  console.log(`  Last auto-cut:  ${wallet.lastAutoRechargeAt ?? 'n/a'}`);
  console.log('');
  await printRecentTx(workspace.id);
}

function ccToPaise(amountCc: number) {
  return Math.round(amountCc * 100);
}

function formatErr(err: unknown) {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('url was not found') || msg.includes('not found on the server')) {
      return (
        'Razorpay Recurring Payments API is not enabled on this merchant account. ' +
        'Contact Razorpay support or enable Recurring Payments in Dashboard → Products.'
      );
    }
    return err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const o = err as { error?: { description?: string; code?: string } };
    if (o.error?.description) {
      return o.error.code ? `${o.error.description} (${o.error.code})` : o.error.description;
    }
  }
  return String(err);
}

main()
  .catch((err) => {
    console.error('\nError:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
