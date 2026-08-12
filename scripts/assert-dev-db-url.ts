/**
 * CLI for db-refresh-dev.sh — exit 0 if URL is safe as a restore target, else 1.
 * Usage: npx tsx scripts/assert-dev-db-url.ts <database-url>
 */
import {
  looksLikeProductionDatabaseUrl,
  parseDatabaseUrl,
} from '../src/lib/prodDbGuard.js';

const url = process.argv[2] || '';
const parsed = parseDatabaseUrl(url);
if (!parsed?.database) {
  console.error('Invalid database URL');
  process.exit(1);
}
if (looksLikeProductionDatabaseUrl(url)) {
  console.error(
    `REFUSE: URL looks like production (${parsed.host}/${parsed.database})`
  );
  process.exit(1);
}
if (!/_(dev|test|staging)$/i.test(parsed.database)) {
  console.error(
    `REFUSE: database name "${parsed.database}" must end with _dev, _test, or _staging`
  );
  process.exit(1);
}
process.exit(0);
