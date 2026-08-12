/**
 * Self-check: inbox 1:1 email helpers (template path + plain wrap).
 * Run: npx tsx backend/src/services/inboxEmailSend.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, 'inboxEmailSend.ts'), 'utf8');

assert.match(src, /interpolateContactTokens/);
assert.match(src, /resolveCampaignEmailVariables/);
assert.match(src, /channel:\s*['"]email['"]/);
assert.match(src, /Contact has no email address/);
assert.match(src, /getEmailService\(\)\.sendEmail/);
assert.match(src, /findOrReopenConversationForInbound/);
assert.match(src, /wrapPlainTextAsHtml/);

// Template path must pass templateId into EmailService (campaign-style HTML).
assert.match(src, /if\s*\(\s*templateId\s*\)/);
const templateBranch = src.match(
  /if\s*\(\s*templateId\s*\)\s*\{[\s\S]*?log\s*=\s*await\s+getEmailService\(\)\.sendEmail\([\s\S]*?\n\s*\}\);/
);
assert.ok(templateBranch, 'expected templateId sendEmail call');
assert.match(templateBranch[0], /templateId:\s*tpl\.id/);
assert.match(templateBranch[0], /variables/);

// Custom path must send html (multipart), not text-only.
assert.match(src, /wrapPlainTextAsHtml\(text\)/);
const customCall = src.match(
  /\/\/ Custom compose[\s\S]*?getEmailService\(\)\.sendEmail\([\s\S]*?\n\s*\}\);/
);
assert.ok(customCall, 'expected custom sendEmail call');
assert.match(customCall[0], /\bhtml\b/);
assert.doesNotMatch(customCall[0], /templateId:/);

console.log('inboxEmailSend.check.ts: ok');
