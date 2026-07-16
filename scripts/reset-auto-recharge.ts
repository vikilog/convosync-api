/**
 * Reset wallet auto-recharge after failed test runs.
 *
 *   npm run wallet:reset-auto-recharge -- --email admin@convosync.io
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { getWalletSummary } from '../src/services/wallet.service.js';

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

async function resolveWorkspaceId(opts: Record<string, string | boolean>) {
  if (typeof opts['workspace-id'] === 'string') return opts['workspace-id'];

  const email =
    (typeof opts.email === 'string' ? opts.email : process.env.TEST_USER_EMAIL)?.trim().toLowerCase();
  if (!email) throw new Error('Pass --email or set TEST_USER_EMAIL');

  const user = await prisma.user.findUnique({
    where: { email },
    select: { workspaceId: true },
  });
  if (!user) throw new Error(`No user for email: ${email}`);
  return user.workspaceId;
}

async function main() {
  const workspaceId = await resolveWorkspaceId(parseArgs(process.argv.slice(2)));

  const before = await prisma.workspaceWallet.findUnique({ where: { workspaceId } });
  if (!before) throw new Error('Wallet not found');

  await prisma.workspaceWallet.update({
    where: { workspaceId },
    data: {
      autoRechargeEnabled: true,
      autoRechargeStatus: 'idle',
      autoRechargeFailCount: 0,
      autoRechargeCooldownUntil: null,
    },
  });

  const wallet = await getWalletSummary(workspaceId);
  console.log('Auto-recharge reset for workspace:', workspaceId);
  console.log(`  enabled: ${before.autoRechargeEnabled} → ${wallet.autoRechargeEnabled}`);
  console.log(`  status: ${before.autoRechargeStatus} → ${wallet.autoRechargeStatus}`);
  console.log(`  fail count: ${before.autoRechargeFailCount} → 0`);
  console.log('\nNote: Razorpay Recurring Payments must still be enabled on your merchant account.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
