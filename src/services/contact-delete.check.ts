/**
 * Runnable self-check (no DB). Mirrors normalizeContactTag in contact-delete.service.ts.
 *   npx tsx src/services/contact-delete.check.ts
 */
import assert from 'node:assert/strict';

function normalizeContactTag(raw: string): string | null {
  const tag = raw.trim();
  return tag.length ? tag : null;
}

assert.equal(normalizeContactTag('VIP'), 'VIP');
assert.equal(normalizeContactTag('  Hot  '), 'Hot');
assert.equal(normalizeContactTag(''), null);
assert.equal(normalizeContactTag('   '), null);

console.log('contact-delete.check.ts: ok');
