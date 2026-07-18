/**
 * Self-check: agents routes must not accept client tenantId overrides.
 * Run: npx tsx backend/src/routes/agents.tenant.lock.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, 'agents.ts'), 'utf8');

assert.doesNotMatch(src, /tenantId:\s*z\.string/);
assert.doesNotMatch(src, /body\.tenantId/);
assert.doesNotMatch(src, /query\.tenantId/);
assert.doesNotMatch(src, /scopedWorkspaceId/);

const routesDir = dir;
const { readdirSync } = await import('node:fs');
for (const name of readdirSync(routesDir)) {
  if (!name.endsWith('.ts') || name.includes('.check.')) continue;
  const text = readFileSync(join(routesDir, name), 'utf8');
  assert.doesNotMatch(
    text,
    /(?:body|query)\.tenantId|tenantId\s*\?\?/,
    `${name} must not override workspace from client tenantId`
  );
}

console.log('agents.tenant.lock.check.ts: ok');
