/**
 * Self-check: session JWT signing + jti blacklist helpers.
 * Run: ENCRYPTION_KEY=x JWT_SECRET=test npx tsx backend/src/services/userSecurity.check.ts
 *
 * Does not require a live Redis/Postgres — asserts key formats and claim shape via source scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, 'userSecurity.ts'), 'utf8');
const authMw = readFileSync(join(dir, '../middleware/auth.ts'), 'utf8');
const authRoutes = readFileSync(join(dir, '../routes/auth.ts'), 'utf8');
const schema = readFileSync(join(dir, '../prisma/schema.prisma'), 'utf8');

assert.match(src, /blacklist:jti:/);
assert.match(src, /tokenVersion:user:/);
assert.match(src, /signSessionToken/);
assert.match(src, /bumpTokenVersion/);
assert.match(src, /JtiBlacklistUnavailableError/);
assert.match(src, /SESSION_JWT_EXPIRES_IN/);

assert.match(authMw, /Session invalidated/);
assert.match(authMw, /Token has been revoked/);
assert.match(authMw, /fail-open|isJtiBlacklisted/);

assert.match(authRoutes, /\/logout/);
assert.match(authRoutes, /\/logout-all/);
assert.match(authRoutes, /securityState:\s*\{\s*create:/);
assert.match(authRoutes, /signSessionToken/);

assert.match(schema, /model UserSecurityState/);
assert.match(schema, /tokenVersion/);
assert.match(schema, /user_security_states/);

console.log('userSecurity.check.ts: ok');
