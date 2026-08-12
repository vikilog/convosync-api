/**
 * Self-check for prod DB URL detection.
 * Run: npx tsx src/lib/prodDbGuard.check.ts
 */
import assert from 'node:assert/strict';
import {
  assertSafeDatabaseUrlForDev,
  looksLikeProductionDatabaseUrl,
  parseDatabaseUrl,
} from './prodDbGuard.js';

assert.deepEqual(parseDatabaseUrl('postgresql://u:p@localhost:5432/convosync_dev'), {
  host: 'localhost',
  database: 'convosync_dev',
  href: 'postgresql://u:p@localhost:5432/convosync_dev',
});

assert.equal(
  looksLikeProductionDatabaseUrl(
    'postgresql://u:p@ep-example.ap-southeast-1.aws.neon.tech/convosync?sslmode=require'
  ),
  true
);

assert.equal(
  looksLikeProductionDatabaseUrl(
    'postgresql://u:p@ep-example.ap-southeast-1.aws.neon.tech/convosync_dev?sslmode=require'
  ),
  false
);

assert.equal(
  looksLikeProductionDatabaseUrl('postgresql://u:p@localhost:5432/convosync'),
  false
);

assert.equal(
  looksLikeProductionDatabaseUrl('postgresql://u:p@db.example.com/convosync', {
    PROD_DB_HOST: 'db.example.com',
  }),
  true
);

assert.throws(
  () =>
    assertSafeDatabaseUrlForDev(
      'postgresql://u:p@ep-x.aws.neon.tech/convosync',
      { NODE_ENV: 'development' }
    ),
  /Refusing to start/
);

assert.doesNotThrow(() =>
  assertSafeDatabaseUrlForDev('postgresql://u:p@ep-x.aws.neon.tech/convosync', {
    NODE_ENV: 'development',
    ALLOW_PROD_DB: '1',
  })
);

assert.doesNotThrow(() =>
  assertSafeDatabaseUrlForDev('postgresql://u:p@localhost:5432/convosync_dev', {
    NODE_ENV: 'development',
  })
);

console.log('prodDbGuard.check: ok');
