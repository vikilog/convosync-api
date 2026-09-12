/**
 * Read-only DISTINCT dumps for string fields that the rewrite will enum-ify.
 * Default: print SQL. --execute runs SELECTs (blocked against prod-like URLs).
 */
import { looksLikeProductionDatabaseUrl } from '../lib/prodDbGuard.js';

const QUERIES = [
  `SELECT "status", COUNT(*) FROM "Campaign" GROUP BY "status" ORDER BY COUNT(*) DESC`,
  `SELECT "status", COUNT(*) FROM "Journey" GROUP BY "status" ORDER BY COUNT(*) DESC`,
  `SELECT "status", COUNT(*) FROM "Template" GROUP BY "status" ORDER BY COUNT(*) DESC`,
  `SELECT "status", COUNT(*) FROM "CallSession" GROUP BY "status" ORDER BY COUNT(*) DESC`,
  `SELECT "status", COUNT(*) FROM "Conversation" GROUP BY "status" ORDER BY COUNT(*) DESC`,
  `SELECT "channel", COUNT(*) FROM "Conversation" GROUP BY "channel" ORDER BY COUNT(*) DESC`,
  `SELECT "assigneeType", COUNT(*) FROM "Conversation" GROUP BY "assigneeType" ORDER BY COUNT(*) DESC`,
  `SELECT "role", COUNT(*) FROM "WorkspaceMembership" GROUP BY "role" ORDER BY COUNT(*) DESC`,
  `SELECT "type", COUNT(*) FROM "WalletTransaction" GROUP BY "type" ORDER BY COUNT(*) DESC`,
  `SELECT "category", COUNT(*) FROM "WalletTransaction" GROUP BY "category" ORDER BY COUNT(*) DESC`,
];

const execute = process.argv.includes('--execute');

if (!execute) {
  console.log('-- identity enum audit (print only). Re-run with --execute against *_dev / *_test.');
  for (const q of QUERIES) console.log(`${q};`);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required for --execute');
  process.exit(1);
}
if (looksLikeProductionDatabaseUrl(url)) {
  console.error('Refusing --execute against a production-like DATABASE_URL');
  process.exit(1);
}

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
try {
  for (const q of QUERIES) {
    console.log(`\n## ${q}`);
    console.log(JSON.stringify(await prisma.$queryRawUnsafe(q), null, 2));
  }
} finally {
  await prisma.$disconnect();
}
