/**
 * Self-check: inbox 1:1 email helpers (escape + plain wrap).
 * Run: npx tsx backend/src/services/inboxEmailSend.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, 'inboxEmailSend.ts'), 'utf8');

assert.match(src, /interpolateContactTokens/);
assert.match(src, /channel:\s*['"]email['"]/);
assert.match(src, /Contact has no email address/);
assert.match(src, /getEmailService\(\)\.sendEmail/);
assert.match(src, /findOrReopenConversationForInbound/);
assert.match(src, /never pass templateId/);
// sendEmail call args must not include templateId (metadata may still store it)
const sendCall = src.match(/getEmailService\(\)\.sendEmail\([\s\S]*?\n\s*\}\);/);
assert.ok(sendCall, 'expected sendEmail call block');
assert.doesNotMatch(sendCall[0], /templateId/);

console.log('inboxEmailSend.check.ts: ok');
