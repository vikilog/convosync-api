/**
 * Self-check: workspace impersonation accepts optional target userId.
 * Run: npx tsx backend/src/services/platformOrganizationAdmin.impersonate.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const adminSrc = readFileSync(join(dir, 'platformOrganizationAdmin.ts'), 'utf8');
const routesSrc = readFileSync(join(dir, '../routes/platform/organizations.ts'), 'utf8');

assert.match(adminSrc, /targetUserId\?: string/);
assert.match(adminSrc, /User is not a member of this workspace/);
assert.match(adminSrc, /impersonatedBy: platformAdminId/);

assert.match(routesSrc, /userId: z\.string\(\)\.min\(1\)\.optional\(\)/);
assert.match(routesSrc, /createWorkspaceImpersonationSession\([\s\S]*body\.userId/);
assert.match(routesSrc, /targetUserId: session\.user\.id/);

console.log('platformOrganizationAdmin.impersonate.check.ts: ok');
