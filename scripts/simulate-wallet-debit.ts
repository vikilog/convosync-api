/**
 * Simulate ConvoCoins (wallet) debit to test low-balance alerts and auto-recharge.
 *
 * Examples:
 *   npm run wallet:simulate-debit -- --email you@example.com --debit 600
 *   npm run wallet:simulate-debit -- --email you@example.com --set-balance 400 --trigger
 *   npm run wallet:simulate-debit -- --email you@example.com --status
 *   npm run wallet:simulate-debit -- --workspace-id clxxx --trigger --clear-cooldown
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { debitWallet, ensureWallet, getWalletSummary } from '../src/services/wallet.service.js';
import {
  processWalletAutoRecharge,
  scheduleWalletAutoRecharge,
} from '../src/services/walletAutoRecharge.service.js';

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

function ccToPaise(cc: number): number {
  return Math.round(cc * 100);
}

function paiseToCc(paise: number): number {
  return paise / 100;
}

function formatWallet(workspace: { name: string; id: string }, wallet: Awaited<ReturnType<typeof getWalletSummary>>) {
  const lines = [
    `Workspace: ${workspace.name} (${workspace.id})`,
    `Balance: ${paiseToCc(wallet.balancePaise)} CC (₹${wallet.balanceInr})`,
    `Low-balance alert: ${paiseToCc(wallet.lowBalanceThresholdPaise)} CC`,
    `Is low balance: ${wallet.isLowBalance ? 'yes' : 'no'}`,
    `Auto-recharge: ${wallet.autoRechargeEnabled ? 'ON' : 'OFF'}`,
    `Auto-recharge amount: ${paiseToCc(wallet.autoRechargeAmountPaise)} CC`,
    `Payment method saved: ${wallet.hasPaymentMethod ? 'yes' : 'no'}`,
    `Auto-recharge status: ${wallet.autoRechargeStatus ?? 'idle'}`,
    `Last auto-recharge: ${wallet.lastAutoRechargeAt ?? 'never'}`,
  ];
  return lines.join('\n');
}

async function resolveWorkspace(opts: Record<string, string | boolean>) {
  if (typeof opts['workspace-id'] === 'string') {
    const workspace = await prisma.workspace.findUnique({
      where: { id: opts['workspace-id'] },
      select: { id: true, name: true },
    });
    if (!workspace) throw new Error(`Workspace not found: ${opts['workspace-id']}`);
    return workspace;
  }

  const email = typeof opts.email === 'string' ? opts.email.trim().toLowerCase() : undefined;
  if (!email) {
    throw new Error('Pass --email <user@example.com> or --workspace-id <id>');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      workspaceId: true,
      workspace: { select: { id: true, name: true } },
    },
  });
  if (!user?.workspace) {
    throw new Error(`No user / workspace found for email: ${email}`);
  }
  return user.workspace;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || opts.h) {
    console.log(`
Usage: npm run wallet:simulate-debit -- [options]

Options:
  --email <email>           User email (uses their primary workspace)
  --workspace-id <id>       Workspace id (overrides email lookup)
  --status                  Only print wallet state
  --debit <cc>              Debit N ConvoCoins (1 CC = ₹1)
  --set-balance <cc>        Set balance to N CC (debits difference)
  --trigger                 Run auto-recharge immediately (Razorpay token charge)
  --queue                   Enqueue auto-recharge job instead of --trigger direct run
  --clear-cooldown          Reset auto-recharge cooldown / charging lock before trigger
  --help                    Show this help

Notes:
  • Balance must drop to ≤ low-balance threshold to trigger auto-recharge.
  • Default threshold is 500 CC unless changed in Wallet settings.
  • Use --trigger for instant test without waiting for backend worker + Redis.
  • Backend must have RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET configured.
`);
    return;
  }

  const workspace = await resolveWorkspace(opts);
  await ensureWallet(workspace.id);

  let wallet = await getWalletSummary(workspace.id);
  console.log('--- Before ---');
  console.log(formatWallet(workspace, wallet));
  console.log('');

  if (opts['clear-cooldown']) {
    await prisma.workspaceWallet.update({
      where: { workspaceId: workspace.id },
      data: {
        autoRechargeStatus: 'idle',
        autoRechargeCooldownUntil: null,
      },
    });
    console.log('Cleared auto-recharge cooldown / charging lock.\n');
  }

  if (typeof opts['set-balance'] === 'string') {
    const targetCc = Number(opts['set-balance']);
    if (!Number.isFinite(targetCc) || targetCc < 0) {
      throw new Error('--set-balance must be a non-negative number (CC)');
    }
    const targetPaise = ccToPaise(targetCc);
    const deltaPaise = wallet.balancePaise - targetPaise;
    if (deltaPaise > 0) {
      await debitWallet({
        workspaceId: workspace.id,
        amountPaise: deltaPaise,
        category: 'adjustment',
        description: 'Test script: simulate usage',
        referenceType: 'test_script',
        idempotencyKey: `test-set-balance:${workspace.id}:${Date.now()}`,
        metadata: { targetBalanceCc: targetCc },
      });
      console.log(`Debited ${paiseToCc(deltaPaise)} CC to reach ${targetCc} CC.\n`);
    } else if (deltaPaise < 0) {
      console.log(
        `Balance already ${paiseToCc(wallet.balancePaise)} CC (target ${targetCc} CC). No debit applied.\n`
      );
    } else {
      console.log(`Balance already ${targetCc} CC. No debit applied.\n`);
    }
  } else if (typeof opts.debit === 'string') {
    const debitCc = Number(opts.debit);
    if (!Number.isFinite(debitCc) || debitCc <= 0) {
      throw new Error('--debit must be a positive number (CC)');
    }
    const amountPaise = ccToPaise(debitCc);
    await debitWallet({
      workspaceId: workspace.id,
      amountPaise,
      category: 'adjustment',
      description: 'Test script: simulate usage',
      referenceType: 'test_script',
      idempotencyKey: `test-debit:${workspace.id}:${Date.now()}`,
      metadata: { debitCc },
    });
    console.log(`Debited ${debitCc} CC.\n`);
  } else if (!opts.status && !opts.trigger && !opts.queue) {
    console.log('No action taken. Pass --debit, --set-balance, --trigger, or --status.\n');
  }

  wallet = await getWalletSummary(workspace.id);
  console.log('--- After ---');
  console.log(formatWallet(workspace, wallet));
  console.log('');

  if (wallet.isLowBalance && wallet.autoRechargeEnabled) {
    console.log('Balance is at or below threshold — auto-recharge eligible.');
  } else if (!wallet.autoRechargeEnabled) {
    console.log('Auto-recharge is OFF. Enable it in Wallet settings first.');
  } else if (!wallet.hasPaymentMethod) {
    console.log('No saved payment method. Complete auto-recharge setup in Wallet settings.');
  } else {
    console.log('Balance is above low-balance threshold — auto-recharge will not run yet.');
  }

  if (opts.trigger) {
    console.log('\nRunning auto-recharge now (direct Razorpay charge)...');
    try {
      await processWalletAutoRecharge(workspace.id);
      wallet = await getWalletSummary(workspace.id);
      console.log('\n--- After auto-recharge ---');
      console.log(formatWallet(workspace, wallet));
    } catch (err) {
      console.error('\nAuto-recharge failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } else if (opts.queue) {
    console.log('\nEnqueueing auto-recharge job (requires backend worker + Redis)...');
    await scheduleWalletAutoRecharge(workspace.id);
    console.log('Job queued. Watch backend logs for processing.');
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
